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
    if (code !== "ENOENT") {
      console.warn(`[store] could not read ${STORE_FILE}:`, (err as Error).message);
    }
  }
}

async function persist(): Promise<void> {
  const tmp = `${STORE_FILE}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fsp.rename(tmp, STORE_FILE);
}

export function listProfiles(): Profile[] {
  return [...db.profiles].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getProfile(id: string): Profile | null {
  return db.profiles.find((p) => p.id === id) ?? null;
}

export async function addProfile(profile: Profile): Promise<Profile> {
  db.profiles.push(profile);
  await persist();
  return profile;
}

export async function saveProfile(profile: Profile): Promise<Profile> {
  const idx = db.profiles.findIndex((p) => p.id === profile.id);
  if (idx === -1) throw new Error(`profile ${profile.id} not found`);
  profile.updatedAt = new Date().toISOString();
  db.profiles[idx] = profile;
  await persist();
  return profile;
}

export async function removeProfile(id: string): Promise<boolean> {
  const profile = getProfile(id);
  if (!profile) return false;

  db.profiles = db.profiles.filter((p) => p.id !== id);
  await persist();

  // Only ever delete inside our own profiles directory.
  const target = path.resolve(profile.userDataDir);
  const root = path.resolve(PROFILES_DIR);
  if (target.startsWith(root + path.sep)) {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.dirname(target), { recursive: true, force: true }).catch(() => {});
  }
  return true;
}

/** Directory holding a profile's user-data-dir. Created lazily on launch. */
export function userDataDirFor(id: string): string {
  return path.join(PROFILES_DIR, id, "user-data");
}
