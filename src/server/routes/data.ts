import fs, { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyPluginAsync } from "fastify";
import {
  DATA_DIR,
  MAX_BACKUP_BYTES,
  MAX_IMPORT_BYTES,
  PROFILES_DIR,
  VERSION,
} from "../../config.js";
import { backupEntries, createBackupStream, extractBackup, inspectBackup } from "../../lib/backup.js";
import {
  importProfile,
  parseImportPayload,
  skippedName,
  type ImportedProfile,
  type SkippedProfile,
} from "../../lib/import.js";
import { hasSession } from "../../runtime.js";
import { addProfiles, listProfiles } from "../../store.js";
import { HttpError } from "../validate.js";

interface ImportResult {
  imported: ImportedProfile[];
  skipped: SkippedProfile[];
}

async function importMany(rawProfiles: unknown[], stageDir?: string): Promise<ImportResult> {
  const imported: ImportedProfile[] = [];
  const skipped: SkippedProfile[] = [];
  const createdDirs: string[] = [];

  try {
    for (const raw of rawProfiles) {
      let item: ImportedProfile;
      try {
        item = importProfile(raw);
      } catch (err) {
        skipped.push({
          name: skippedName(raw),
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (stageDir) {
        const source = item.sourceId
          ? path.join(stageDir, "profiles", item.sourceId)
          : undefined;
        if (source && fs.existsSync(source) && fs.statSync(source).isDirectory()) {
          const target = path.join(PROFILES_DIR, item.profile.id);
          // Register before copying so a failed copy is cleaned up by the outer catch.
          createdDirs.push(target);
          await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: true });
          if (!fs.existsSync(path.join(target, "user-data"))) {
            item.warnings.push("The backup entry has no user-data directory.");
          }
        } else {
          item.warnings.push("No browser data was found in the backup for this profile.");
        }
      }

      imported.push(item);
    }

    await addProfiles(imported.map((item) => item.profile));
  } catch (err) {
    await Promise.all(
      createdDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => {})),
    );
    throw err;
  }

  return { imported, skipped };
}

function importResponse(result: ImportResult) {
  return {
    ok: true,
    imported: result.imported.length,
    profiles: result.imported.map((item) => ({
      ...item.profile,
      fingerprintSeed: item.profile.fingerprint.seed,
    })),
    skipped: result.skipped,
    warnings: result.imported.flatMap((item) =>
      item.warnings.map((message) => ({ profile: item.profile.name, message })),
    ),
  };
}

function readJson(body: Buffer | string): unknown {
  try {
    return JSON.parse(body.toString());
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export const dataRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/export", async (_req, reply) => {
    const payload = {
      format: "virtual-browser/export",
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: VERSION,
      // The absolute user-data path is machine-specific and is reassigned on import.
      profiles: listProfiles().map(({ userDataDir: _userDataDir, ...profile }) => profile),
    };
    reply.header(
      "Content-Disposition",
      `attachment; filename="virtual-browser-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.post(
    "/api/import",
    { bodyLimit: MAX_IMPORT_BYTES },
    async (req, reply) => {
      const result = await importMany(parseImportPayload(req.body));
      reply.code(201);
      return importResponse(result);
    },
  );

  app.get("/api/backup", async (req, reply) => {
    const profiles = listProfiles();
    const active = profiles.filter((profile) => hasSession(profile.id));
    if (active.length > 0) {
      const names = active.slice(0, 5).map((profile) => profile.name).join(", ");
      throw new HttpError(
        409,
        `stop these profiles before backing up: ${names}${active.length > 5 ? ", …" : ""}`,
      );
    }

    const filename = `virtual-browser-backup-${new Date().toISOString().slice(0, 10)}.tar.gz`;
    const stream = createBackupStream(backupEntries(profiles));
    stream.on("error", (err) => {
      req.log.error({ err }, "backup stream failed");
      reply.raw.destroy(err instanceof Error ? err : new Error(String(err)));
    });

    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    reply.header("Cache-Control", "no-store");
    reply.type("application/gzip");
    return reply.send(stream);
  });

  app.post<{ Body: NodeJS.ReadableStream }>(
    "/api/restore",
    { bodyLimit: MAX_BACKUP_BYTES },
    async (req, reply) => {
      const body = req.body;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== "function") {
        throw new HttpError(415, "send the backup as application/gzip");
      }

      await fsp.mkdir(DATA_DIR, { recursive: true });
      const tmpDir = await fsp.mkdtemp(path.join(DATA_DIR, ".restore-"));
      const archive = path.join(tmpDir, "backup.tar.gz");
      const stageDir = path.join(tmpDir, "extract");

      try {
        let bytes = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.length;
            if (bytes > MAX_BACKUP_BYTES) {
              callback(new HttpError(413, "backup exceeds the configured size limit"));
              return;
            }
            callback(null, chunk);
          },
        });
        await pipeline(body, limiter, createWriteStream(archive, { mode: 0o600 }));

        await inspectBackup(archive);
        await fsp.mkdir(stageDir, { recursive: true });
        await extractBackup(archive, stageDir);

        const store = await fsp.readFile(path.join(stageDir, "profiles.json"), "utf8");
        const result = await importMany(parseImportPayload(readJson(store)), stageDir);
        reply.code(201);
        return importResponse(result);
      } finally {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );
};
