/**
 * End-to-end data safety test: JSON export/import, full backup/restore, and
 * archive path validation.
 *
 * Start a throwaway server first:
 *   VB_HEADLESS=1 VB_PORT=8799 VB_DATA_DIR=/tmp/opencode/vb-data npm start
 *   npx tsx scripts/verify-data.ts http://127.0.0.1:8799
 */
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { c as createTar } from "tar";
import { isSafeTarPath } from "../src/lib/backup.js";

const base = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.VB_TOKEN ?? "";
const stamp = Date.now().toString(36);
const name = `Data smoke ${stamp}`;

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return token ? { ...extra, "x-vb-token": token } : extra;
}

async function json(pathname: string, options: { method?: string; body?: unknown } = {}) {
  const headers = authHeaders(
    options.body === undefined ? {} : { "content-type": "application/json" },
  );
  const response = await fetch(`${base}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    throw new Error(`${options.method ?? "GET"} ${pathname}: ${data?.error ?? response.status}`);
  }
  return data;
}

async function raw(pathname: string, body: Buffer) {
  const result = await rawRequest(pathname, body);
  if (!result.ok) {
    throw new Error(`POST ${pathname}: ${result.data?.error ?? result.status}`);
  }
  return result.data;
}

async function rawRequest(pathname: string, body: Buffer) {
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: authHeaders({ "content-type": "application/gzip" }),
    body,
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: response.ok, status: response.status, data };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function cleanup() {
  try {
    const data = await json("/api/profiles");
    for (const profile of data.profiles ?? []) {
      if (profile.name === name || profile.name.startsWith(`${name} (`)) {
        await json(`/api/profiles/${profile.id}`, { method: "DELETE" });
      }
    }
  } catch (err) {
    console.warn("cleanup skipped:", (err as Error).message);
  }
}

async function main(): Promise<void> {
  // Reject traversal, absolute paths, Windows separators and unknown roots.
  check(isSafeTarPath("profiles.json"), "profiles.json should be allowed");
  check(
    isSafeTarPath("profiles/00000000-0000-4000-8000-000000000000/user-data/Cookies"),
    "profile data should be allowed",
  );
  check(!isSafeTarPath("../evil"), "parent traversal should be rejected");
  check(!isSafeTarPath("profiles/../evil"), "nested traversal should be rejected");
  check(!isSafeTarPath("/etc/passwd"), "absolute paths should be rejected");
  check(!isSafeTarPath("profiles\\..\\evil"), "backslashes should be rejected");
  check(!isSafeTarPath("profiles/not-a-uuid/file"), "unknown profile ids should be rejected");
  console.log("  ok  archive path validation");

  const system = await json("/api/system");
  const badDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vb-bad-archive-"));
  try {
    await fsp.writeFile(path.join(badDir, "evil.txt"), "owned", "utf8");
    const badArchive = path.join(badDir, "bad.tar.gz");
    await createTar(
      { gzip: true, file: badArchive, cwd: badDir, prefix: "../" },
      ["evil.txt"],
    );
    const badResult = await rawRequest("/api/restore", await fsp.readFile(badArchive));
    check(badResult.status === 400, `traversal archive should be rejected, got ${badResult.status}`);
    await fsp.access(path.join(system.dataDir, "evil.txt")).then(
      () => {
        throw new Error("traversal archive wrote outside the staging directory");
      },
      () => {},
    );
    console.log("  ok  traversal archive is rejected");
  } finally {
    await fsp.rm(badDir, { recursive: true, force: true }).catch(() => {});
  }

  const created = await json("/api/profiles", {
    method: "POST",
    body: {
      name,
      tags: ["data-smoke", "us"],
      notes: "import/restore smoke",
      osProfile: "windows",
      startUrl: "https://example.com/",
      proxy: {
        type: "socks5",
        host: "127.0.0.1",
        port: 1080,
        username: "smoke",
        password: "secret",
        label: "test proxy",
      },
    },
  });
  const original = created.profile;
  await fsp.mkdir(original.userDataDir, { recursive: true });
  await fsp.writeFile(path.join(original.userDataDir, "marker.txt"), "backup-marker-ok", "utf8");
  if (process.platform !== "win32") {
    // Backups skip symlinks but preserve safe hardlinks, so this archive must
    // pass our own restore validation.
    await fsp.symlink("marker.txt", path.join(original.userDataDir, "marker-link.txt"));
    await fsp.link(
      path.join(original.userDataDir, "marker.txt"),
      path.join(original.userDataDir, "marker-hard.txt"),
    );
  }
  console.log("  ok  create profile + browser data marker");

  try {
    const exported = await json("/api/export");
    check(exported.format === "virtual-browser/export", "export format mismatch");
    check(exported.version === 1, "export version mismatch");
    check(exported.profiles.length >= 1, "export should contain the profile");
    check(
      !Object.hasOwn(exported.profiles[0], "userDataDir"),
      "export should not contain absolute data paths",
    );
    console.log("  ok  JSON export");

    const imported = await json("/api/import", { method: "POST", body: exported });
    check(imported.imported >= 1, "JSON import should create a profile");
    const importedProfile = imported.profiles.find(
      (profile: { id: string; name: string }) => profile.name === name && profile.id !== original.id,
    );
    check(importedProfile, "imported profile not found");
    check(
      importedProfile.fingerprint.seed === original.fingerprint.seed,
      "import should preserve the fingerprint seed",
    );
    check(importedProfile.userDataDir !== original.userDataDir, "import must assign a new data dir");
    check(
      importedProfile.proxy?.password === "secret" &&
        importedProfile.proxy?.label === "test proxy",
      "import should preserve proxy credentials and label",
    );
    check(
      importedProfile.tags?.includes("data-smoke"),
      "import should preserve tags",
    );
    console.log("  ok  JSON import (new id, preserved fingerprint/proxy)");

    const backup = await fetch(`${base}/api/backup`, { headers: authHeaders() });
    check(backup.ok, `backup failed: ${backup.status}`);
    check(backup.headers.get("content-type")?.includes("gzip"), "backup content-type is not gzip");
    const archive = Buffer.from(await backup.arrayBuffer());
    check(archive.length > 100, "backup archive is unexpectedly small");
    console.log(`  ok  full backup (${archive.length} bytes)`);

    const restored = await raw("/api/restore", archive);
    const existingIds = new Set([original.id, importedProfile.id]);
    const restoredProfiles = restored.profiles.filter(
      (profile: { id: string; name: string }) => profile.name === name && !existingIds.has(profile.id),
    );
    check(restoredProfiles.length >= 1, "restore should create profiles");
    check(
      restoredProfiles.some(
        (profile: { fingerprint: { seed: string } }) =>
          profile.fingerprint.seed === original.fingerprint.seed,
      ),
      "restore should preserve the fingerprint seed",
    );

    let markerRestored = false;
    let hardlinkRestored = false;
    for (const profile of restoredProfiles) {
      try {
        const marker = await fsp.readFile(path.join(profile.userDataDir, "marker.txt"), "utf8");
        if (marker === "backup-marker-ok") markerRestored = true;
        const hard = await fsp.readFile(
          path.join(profile.userDataDir, "marker-hard.txt"),
          "utf8",
        );
        if (hard === "backup-marker-ok") hardlinkRestored = true;
      } catch {
        // The metadata-only profile in the backup has no browser data.
      }
      await fsp.lstat(path.join(profile.userDataDir, "marker-link.txt")).then(
        () => {
          throw new Error("backup included a symlink and restore accepted it");
        },
        () => {},
      );
    }
    check(markerRestored, "restored archive is missing the browser data marker");
    if (process.platform !== "win32") {
      check(hardlinkRestored, "restored archive is missing hardlinked browser data");
    }
    console.log("  ok  full restore (browser data copied, ids remapped, links handled)");

    const bad = await json("/api/import", { method: "POST", body: { profiles: [{ name: "" }] } });
    check(bad.imported === 0 && bad.skipped.length === 1, "invalid profile should be skipped");
    console.log("  ok  invalid profile is skipped without aborting the import");
  } finally {
    await cleanup();
  }

  console.log("\nOK: data import/export/backup/restore verified.");
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  void cleanup().finally(() => process.exit(1));
});
