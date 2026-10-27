import fs from "node:fs";
import path from "node:path";
import { c as createTar, t as listTar, x as extractTar } from "tar";
import {
  DATA_DIR,
  MAX_BACKUP_ENTRIES,
  MAX_BACKUP_UNCOMPRESSED_BYTES,
  PROFILES_DIR,
} from "../config.js";
import { HttpError } from "../server/validate.js";
import type { Profile } from "../types.js";

/** Files Chrome uses to coordinate a single running instance; never restore them. */
const CHROME_LOCKS = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket"]);

export function isSafeTarPath(value: string): boolean {
  if (!value || value.length > 4096) return false;
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;

  const clean = value.replace(/\/+$/, "");
  if (!clean) return false;

  const parts = clean.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  if (clean === "profiles.json" || clean === "manifest.json" || clean === "profiles") return true;

  const [root, profileId] = parts;
  return root === "profiles" && Boolean(profileId && /^[0-9a-f-]{36}$/i.test(profileId));
}

export function backupEntries(profiles: Profile[]): string[] {
  const entries = ["profiles.json"];
  for (const profile of profiles) {
    if (!/^[0-9a-f-]{36}$/i.test(profile.id)) continue;
    const dir = path.join(PROFILES_DIR, profile.id);
    if (fs.existsSync(dir)) entries.push(`profiles/${profile.id}`);
  }
  return entries;
}

export function createBackupStream(entries: string[]) {
  return createTar(
    {
      gzip: true,
      cwd: DATA_DIR,
      portable: true,
      follow: false,
      filter: (entryPath, entry) => {
        if (CHROME_LOCKS.has(path.basename(entryPath))) return false;
        // The create filter always receives Stats; ReadEntry only appears when
        // listing, where this stream is not used.
        if (!("isFile" in entry)) return true;
        return entry.isFile() || entry.isDirectory();
      },
    },
    entries,
  );
}

export interface BackupInspection {
  entries: number;
  uncompressedBytes: number;
  hasStore: boolean;
}

/**
 * Validate an uploaded archive before touching the data directory. Rejects
 * traversal, absolute paths, symlinks, unsafe hardlink targets, devices,
 * oversized archives and archives without the profile store.
 */
export async function inspectBackup(file: string): Promise<BackupInspection> {
  let entries = 0;
  let uncompressedBytes = 0;
  let hasStore = false;
  let failure: HttpError | undefined;
  const filePaths = new Set<string>();

  await listTar({
    file,
    onentry(entry) {
      if (failure) return;

      entries += 1;
      if (entries > MAX_BACKUP_ENTRIES) {
        failure = new HttpError(413, `backup has more than ${MAX_BACKUP_ENTRIES} entries`);
        return;
      }
      if (!isSafeTarPath(entry.path)) {
        failure = new HttpError(400, `unsafe path in backup: ${entry.path.slice(0, 200)}`);
        return;
      }

      if (entry.type === "Link") {
        const target = entry.linkpath ?? "";
        if (!target || !isSafeTarPath(target) || !filePaths.has(target)) {
          failure = new HttpError(
            400,
            `hardlink target must be a safe file that appears earlier: ${target.slice(0, 200)}`,
          );
          return;
        }
      } else if (entry.type !== "File" && entry.type !== "Directory") {
        failure = new HttpError(400, `unsupported entry type in backup: ${entry.type}`);
        return;
      }

      if (entry.type === "File") {
        filePaths.add(entry.path);
        if (entry.path === "profiles.json") hasStore = true;
      }
      uncompressedBytes += entry.size ?? 0;
      if (uncompressedBytes > MAX_BACKUP_UNCOMPRESSED_BYTES) {
        failure = new HttpError(413, "backup expands beyond the allowed size");
      }
    },
  }).catch((err) => {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "invalid or corrupted backup archive");
  });

  // `onentry` runs inside tar's parser event loop; throwing there would crash
  // the process instead of rejecting the request. Record the failure and throw
  // after listing has finished.
  if (failure) throw failure;
  if (!hasStore) {
    throw new HttpError(400, "backup is missing profiles.json");
  }
  return { entries, uncompressedBytes, hasStore };
}

/** Extract an already-inspected archive into a fresh staging directory. */
export async function extractBackup(file: string, destination: string): Promise<void> {
  await extractTar({
    file,
    cwd: destination,
    preservePaths: false,
    noChmod: true,
    filter: (entryPath, entry) => {
      if (!isSafeTarPath(entryPath) || !("type" in entry)) return false;
      if (entry.type === "File" || entry.type === "Directory") return true;
      return entry.type === "Link" && isSafeTarPath(entry.linkpath ?? "");
    },
  });
}
