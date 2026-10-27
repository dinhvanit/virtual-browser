import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { HOST, PORT, PUBLIC_DIR, VERSION } from "../config.js";
import { shutdownAll } from "../runtime.js";
import { initStore } from "../store.js";
import { safeEqual } from "../util/random.js";
import { profileRoutes } from "./routes/profiles.js";
import { runtimeRoutes } from "./routes/runtime.js";
import { systemRoutes } from "./routes/system.js";
import { HttpError } from "./validate.js";

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.VB_LOG_LEVEL ?? "info",
    },
    bodyLimit: 1024 * 1024,
    trustProxy: false,
  });

  const token = process.env.VB_TOKEN;
  if (token) {
    app.addHook("onRequest", async (req, reply) => {
      if (!req.url.startsWith("/api")) return;
      const provided = req.headers["x-vb-token"];
      if (typeof provided !== "string" || !safeEqual(provided, token)) {
        reply.code(401).send({ error: "unauthorized" });
      }
    });
  }

  /**
   * CSRF guard. The API is localhost-only, but any website the user visits can
   * still submit a form or fetch to 127.0.0.1. Mutating routes must therefore
   * come from the same origin either via `Origin` or `Sec-Fetch-Site`.
   */
  const loopbackBind = ["127.0.0.1", "localhost", "::1"].includes(HOST);
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api")) return;

    // DNS rebinding: a hostile domain resolving to 127.0.0.1 would otherwise
    // be "same origin" if it controls its own Host header.
    if (loopbackBind && req.headers.host) {
      const hostname = req.headers.host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
      if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
        reply.code(403).send({ error: "unexpected host header" });
        return;
      }
    }

    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;

    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) {
          reply.code(403).send({ error: "cross-origin request rejected" });
          return;
        }
      } catch {
        reply.code(403).send({ error: "invalid origin" });
        return;
      }
    }

    const site = req.headers["sec-fetch-site"];
    if (typeof site === "string" && site !== "same-origin" && site !== "none") {
      reply.code(403).send({ error: "cross-site request rejected" });
    }
  });

  app.addHook("onSend", async (_req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
  });

  app.setErrorHandler((err, req, reply) => {
    const status =
      err instanceof HttpError
        ? err.statusCode
        : typeof (err as { statusCode?: number }).statusCode === "number"
          ? (err as { statusCode: number }).statusCode
          : 500;

    if (status >= 500) req.log.error({ err }, "request failed");
    reply.code(status).send({
      error: (err as Error).message || "internal error",
      statusCode: status,
    });
  });

  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: "/",
    index: ["index.html"],
    cacheControl: false,
    setHeaders(res, filePath) {
      if (path.extname(filePath) === ".html") {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  });

  await app.register(systemRoutes);
  await app.register(profileRoutes);
  await app.register(runtimeRoutes);

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      reply.code(404).send({ error: `no route for ${req.method} ${req.url}` });
      return;
    }
    reply.code(404).send({ error: "not found" });
  });

  return app;
}

async function main(): Promise<void> {
  await initStore();
  const app = await buildServer();

  const close = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      await shutdownAll();
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));

  await app.listen({ host: HOST, port: PORT });
  app.log.info(
    `Virtual Browser v${VERSION} ready at http://${HOST}:${PORT} (data: ${process.env.VB_DATA_DIR ?? "./data"})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
