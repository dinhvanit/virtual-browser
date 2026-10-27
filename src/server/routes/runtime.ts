import type { FastifyPluginAsync } from "fastify";
import {
  activateTab,
  closeTab,
  describeProfile,
  launchProfile,
  navigateProfile,
  openTab,
  sessionSnapshot,
  stopProfile,
} from "../../runtime.js";
import { getProfile } from "../../store.js";
import { HttpError, parseId, parseIndex } from "../validate.js";

function requireProfile(id: string) {
  const profile = getProfile(parseId(id));
  if (!profile) throw new HttpError(404, `profile ${id} not found`);
  return profile;
}

interface IdParams {
  id: string;
}

interface TabParams extends IdParams {
  index: string;
}

export const runtimeRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: IdParams }>("/api/profiles/:id/session", async (req) => {
    requireProfile(req.params.id);
    return { status: await describeProfile(req.params.id) };
  });

  app.get<{ Params: IdParams }>("/api/profiles/:id/thumbnail", async (req, reply) => {
    requireProfile(req.params.id);
    const { thumbnail } = await sessionSnapshot(req.params.id);
    if (!thumbnail) {
      reply.code(204);
      return null;
    }
    reply
      .header("Cache-Control", "no-store, max-age=0")
      .header("Content-Type", "image/jpeg")
      .send(thumbnail);
  });

  app.post<{ Params: IdParams }>("/api/profiles/:id/launch", async (req) => {
    const profile = requireProfile(req.params.id);
    const status = await launchProfile(profile);
    return { status };
  });

  app.post<{ Params: IdParams }>("/api/profiles/:id/stop", async (req) => {
    requireProfile(req.params.id);
    return { status: await stopProfile(req.params.id) };
  });

  app.post<{ Params: IdParams; Body: { url?: unknown } }>(
    "/api/profiles/:id/navigate",
    async (req) => {
      requireProfile(req.params.id);
      const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
      if (!url) throw new HttpError(400, "url is required");
      return { status: await navigateProfile(req.params.id, url) };
    },
  );

  app.post<{ Params: IdParams; Body: { url?: unknown } }>("/api/profiles/:id/tabs", async (req) => {
    requireProfile(req.params.id);
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "about:blank";
    return { status: await openTab(req.params.id, url) };
  });

  app.post<{ Params: TabParams }>("/api/profiles/:id/tabs/:index/activate", async (req) => {
    requireProfile(req.params.id);
    return {
      status: await activateTab(req.params.id, parseIndex(req.params.index)),
    };
  });

  app.delete<{ Params: TabParams }>("/api/profiles/:id/tabs/:index", async (req) => {
    requireProfile(req.params.id);
    return {
      status: await closeTab(req.params.id, parseIndex(req.params.index)),
    };
  });
};
