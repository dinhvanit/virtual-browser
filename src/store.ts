import fsp from "node:fs/promises";
import path from "node:path";
import { PROFILES_DIR, STORE_FILE } from "./config.js";
import type { Profile } from "./types.js";

interface DB {
  version: 1;
  profiles: Profile[];
}

let db: DB = { version: 1, profiles: [] };

export async function initStore(): Promise<void> {
  await fsp.mkdir(PROFILES_DIR, { recursive: true });
  try {
    const raw = await fsp.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw) as DB;
    if (parsed && Array.isArray(parsed.profiles)) db = parsed;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // A fresh data dir needs a valid store file so a full backup can include it.
      await persist();
    } else {
      console.warn(`[store] could not read ${STORE_FILE}:`, (err as Error).message);
    }
  }
}

async function persist(): Promise<void> {
  const tmp = `${STORE_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fsp.rename(tmp, STORE_FILE);
}

/**
 * Mutations are serialized so an import and a concurrent edit cannot interleave
 * their in-memory changes or stale snapshots. Reads stay synchronous and fast.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.catch(() => {});
  return next;
}

export function listProfiles(): Profile[] {
  return [...db.profiles].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getProfile(id: string): Profile | null {
  return db.profiles.find((p) => p.id === id) ?? null;
}

export async function addProfile(profile: Profile): Promise<Profile> {
  await addProfiles([profile]);
  return profile;
}

/**
 * Add a batch of profiles with a single atomic write. Used by import/restore so
 * a failed persist cannot leave a partially imported set in the JSON store.
 */
export function addProfiles(profiles: Profile[]): Promise<Profile[]> {
  return enqueue(async () => {
    if (profiles.length === 0) return profiles;

    const existing = new Set(db.profiles.map((p) => p.id));
    for (const profile of profiles) {
      if (existing.has(profile.id)) throw new Error(`profile ${profile.id} already exists`);
      existing.add(profile.id);
    }

    const added = new Set(profiles.map((profile) => profile.id));
    db.profiles = [...db.profiles, ...profiles];
    try {
      await persist();
    } catch (err) {
      db.profiles = db.profiles.filter((profile) => !added.has(profile.id));
      throw err;
    }
    return profiles;
  });
}

export function saveProfile(profile: Profile): Promise<Profile> {
  return enqueue(async () => {
    const idx = db.profiles.findIndex((p) => p.id === profile.id);
    if (idx === -1) throw new Error(`profile ${profile.id} not found`);
    const previous = db.profiles[idx];
    profile.updatedAt = new Date().toISOString();
    db.profiles[idx] = profile;
    try {
      await persist();
    } catch (err) {
      db.profiles[idx] = previous;
      throw err;
    }
    return profile;
  });
}

export function removeProfile(id: string): Promise<boolean> {
  return enqueue(async () => {
    const idx = db.profiles.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    const profile = db.profiles[idx];

    db.profiles = db.profiles.filter((p) => p.id !== id);
    try {
      await persist();
    } catch (err) {
      db.profiles.splice(idx, 0, profile);
      throw err;
    }

    // Only ever delete the profile's own directory. Checking the user-data
    // path before removing its parent prevents a hand-edited store from
    // deleting PROFILES_DIR (or anything outside it).
    const profileDir = path.resolve(PROFILES_DIR, profile.id);
    const target =
      typeof profile.userDataDir === "string" ? path.resolve(profile.userDataDir) : "";
    const safeId = /^[0-9a-f-]{36}$/i.test(profile.id);
    if (
      safeId &&
      target &&
      (target === profileDir || target.startsWith(profileDir + path.sep))
    ) {
      await fsp.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    }
    return true;
  });
}

/** Directory holding a profile's user-data-dir. Created lazily on launch. */
export function userDataDirFor(id: string): string {
  return path.join(PROFILES_DIR, id, "user-data");
}
