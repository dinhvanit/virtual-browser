import os from "node:os";
import type { FastifyPluginAsync } from "fastify";
import {
  CHROME_PATH,
  DATA_DIR,
  DEFAULT_START_URL,
  HEADLESS,
  PORT,
  VERSION,
  WIREPROXY_PATH,
} from "../../config.js";
import { chromeVersion } from "../../lib/fingerprint.js";
import { listProfiles } from "../../store.js";

export const systemRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/health", async () => ({
    ok: true,
    version: VERSION,
    uptimeSec: Math.round(process.uptime()),
    profiles: listProfiles().length,
  }));

  app.get("/api/system", async () => ({
    version: VERSION,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    hostname: os.hostname(),
    chrome: {
      path: CHROME_PATH,
      version: CHROME_PATH ? chromeVersion() : null,
      found: Boolean(CHROME_PATH),
    },
    wireproxy: {
      path: WIREPROXY_PATH,
      found: Boolean(WIREPROXY_PATH),
    },
    headless: HEADLESS,
    dataDir: DATA_DIR,
    port: PORT,
    defaultStartUrl: DEFAULT_START_URL,
    proxyTypes: ["http", "https", "socks5"],
    geoProviders: ["ipwho.is", "ipapi.co"],
  }));

  app.get("/api/export", async (_req, reply) => {
    const payload = {
      format: "virtual-browser/export",
      version: 1,
      exportedAt: new Date().toISOString(),
      appVersion: VERSION,
      profiles: listProfiles(),
    };
    reply.header(
      "Content-Disposition",
      `attachment; filename="virtual-browser-${new Date().toISOString().slice(0, 10)}.json"`,
    );
    return payload;
  });
};
