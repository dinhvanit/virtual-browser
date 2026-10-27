import type { FastifyPluginAsync } from "fastify";
import { DEFAULT_START_URL } from "../../config.js";
import { checkProxy } from "../../lib/geo.js";
import { applyGeo, generateFingerprint } from "../../lib/fingerprint.js";
import { startVpn, stopVpn, vpnStatus } from "../../lib/vpn.js";
import {
  addProfile,
  getProfile,
  listProfiles,
  removeProfile,
  saveProfile,
  userDataDirFor,
} from "../../store.js";
import {
  describeProfile,
  effectiveFingerprint,
  isActive,
  stopProfile,
} from "../../runtime.js";
import type { Profile, ProxyConfig } from "../../types.js";
import { newId } from "../../util/random.js";
import {
  HttpError,
  parseId,
  parseProfileInput,
  parseProxy,
} from "../validate.js";

function getOr404(id: string): Profile {
  const profile = getProfile(parseId(id));
  if (!profile) throw new HttpError(404, `profile ${id} not found`);
  return profile;
}

function profileResponse(profile: Profile) {
  return {
    ...profile,
    fingerprint: effectiveFingerprint(profile),
    fingerprintSeed: profile.fingerprint.seed,
  };
}

export const profileRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/profiles", async () => {
    const profiles = listProfiles();
    return {
      profiles: await Promise.all(
        profiles.map(async (profile) => ({
          ...profileResponse(profile),
          runtime: await describeProfile(profile.id),
        })),
      ),
    };
  });

  app.get<{ Params: { id: string } }>("/api/profiles/:id", async (req) => {
    const profile = getOr404(req.params.id);
    return {
      profile: profileResponse(profile),
      runtime: await describeProfile(profile.id),
    };
  });

  app.post("/api/profiles", async (req, reply) => {
    const input = parseProfileInput(req.body, { requireName: true });
    const id = newId();
    const now = new Date().toISOString();

    const fingerprint = generateFingerprint({
      seed: id,
      osProfile: input.osProfile ?? "native",
      locale: input.locale ?? undefined,
      timezone: input.timezone ?? undefined,
      pinLocale: input.locale !== undefined && input.locale !== null,
      pinTimezone: input.timezone !== undefined && input.timezone !== null,
    });

    const profile: Profile = {
      id,
      name: input.name!,
      notes: input.notes ?? undefined,
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      userDataDir: userDataDirFor(id),
      startUrl: input.startUrl ?? DEFAULT_START_URL,
      proxy: input.proxy ?? undefined,
      vpn: input.vpn ?? undefined,
      fingerprint,
      geo: undefined,
      geoError: undefined,
    };

    await addProfile(profile);
    reply.code(201);
    return { profile: profileResponse(profile) };
  });

  app.patch<{ Params: { id: string } }>("/api/profiles/:id", async (req) => {
    const profile = getOr404(req.params.id);
    const input = parseProfileInput(req.body, { requireName: false });

    if (input.name !== undefined) profile.name = input.name;
    if (input.notes !== undefined) profile.notes = input.notes ?? undefined;
    if (input.tags !== undefined) profile.tags = input.tags;
    if (input.startUrl !== undefined) profile.startUrl = input.startUrl;

    if (input.proxy !== undefined) {
      if (profile.proxy || input.proxy) {
        profile.geo = undefined;
        profile.geoError = undefined;
        profile.lastCheck = undefined;
      }
      profile.proxy = input.proxy ?? undefined;
    }

    if (input.vpn !== undefined) {
      if (profile.vpn || input.vpn) {
        profile.geo = undefined;
        profile.geoError = undefined;
        profile.lastCheck = undefined;
      }
      profile.vpn = input.vpn ?? undefined;
      // Turning the VPN off must not leave a stale "active" badge behind.
      if (!input.vpn) await stopVpn(profile.id);
    }

    if (
      input.osProfile !== undefined ||
      input.locale !== undefined ||
      input.timezone !== undefined
    ) {
      const pinLocale =
        input.locale === undefined
          ? Boolean(profile.fingerprint.localePinned)
          : input.locale !== null;
      const pinTimezone =
        input.timezone === undefined
          ? Boolean(profile.fingerprint.timezonePinned)
          : input.timezone !== null;

      const regenerated = generateFingerprint({
        seed: profile.fingerprint.seed ?? `${profile.id}:${newId()}`,
        osProfile: input.osProfile ?? profile.fingerprint.osProfile,
        locale:
          input.locale === null
            ? undefined
            : input.locale ?? profile.fingerprint.locale,
        timezone:
          input.timezone === null
            ? undefined
            : input.timezone ?? profile.fingerprint.timezone,
        pinLocale,
        pinTimezone,
      });
      profile.fingerprint = applyGeo(regenerated, profile.geo);
    }

    await saveProfile(profile);
    return { profile: profileResponse(profile), runtime: await describeProfile(profile.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/profiles/:id", async (req) => {
    const profile = getOr404(req.params.id);
    await stopProfile(profile.id);
    await removeProfile(profile.id);
    return { ok: true, id: profile.id };
  });

  app.post<{ Params: { id: string } }>("/api/profiles/:id/duplicate", async (req, reply) => {
    const source = getOr404(req.params.id);
    const id = newId();
    const now = new Date().toISOString();

    const fingerprint = generateFingerprint({
      seed: id,
      osProfile: source.fingerprint.osProfile,
      locale: source.fingerprint.locale,
      timezone: source.fingerprint.timezone,
      pinLocale: Boolean(source.fingerprint.localePinned),
      pinTimezone: Boolean(source.fingerprint.timezonePinned),
    });

    const copy: Profile = {
      id,
      name: `${source.name} (copy)`.slice(0, 80),
      notes: source.notes,
      tags: source.tags ? [...source.tags] : [],
      createdAt: now,
      updatedAt: now,
      userDataDir: userDataDirFor(id),
      startUrl: source.startUrl,
      proxy: source.proxy ? { ...source.proxy } : undefined,
      vpn: source.vpn ? { ...source.vpn } : undefined,
      fingerprint,
    };

    await addProfile(copy);
    reply.code(201);
    return { profile: profileResponse(copy) };
  });

  app.post<{ Params: { id: string } }>("/api/profiles/:id/fingerprint", async (req) => {
    const profile = getOr404(req.params.id);
    const input = parseProfileInput(req.body ?? {}, { requireName: false });

    const fingerprint = generateFingerprint({
      seed: newId(),
      osProfile: input.osProfile ?? profile.fingerprint.osProfile,
      locale:
        input.locale === null
          ? undefined
          : input.locale ?? profile.fingerprint.locale,
      timezone:
        input.timezone === null
          ? undefined
          : input.timezone ?? profile.fingerprint.timezone,
      pinLocale: input.locale !== undefined && input.locale !== null,
      pinTimezone: input.timezone !== undefined && input.timezone !== null,
    });

    profile.fingerprint = applyGeo(fingerprint, profile.geo);
    await saveProfile(profile);
    return { profile: profileResponse(profile) };
  });

  app.get<{ Params: { id: string } }>("/api/profiles/:id/fingerprint", async (req) => {
    const profile = getOr404(req.params.id);
    return {
      stored: profile.fingerprint,
      effective: effectiveFingerprint(profile),
    };
  });

  /**
   * Probe the exit IP. For VPN profiles this boots wireproxy just long enough
   * to run the lookup, and stops it again if the profile is not running.
   */
  app.post<{ Params: { id: string } }>("/api/profiles/:id/check", async (req) => {
    const profile = getOr404(req.params.id);
    const vpnAlreadyActive = vpnStatus(profile.id).active;
    let probeProxy: ProxyConfig | undefined = profile.proxy;
    let startedVpn = false;

    if (profile.vpn?.kind === "wireguard") {
      const port = await startVpn(profile.id, profile.vpn.configPath);
      probeProxy = { type: "socks5", host: "127.0.0.1", port };
      startedVpn = !vpnAlreadyActive;
    }

    try {
      const result = await checkProxy(probeProxy);
      profile.lastCheck = result;
      if (result.ok && result.geo) {
        profile.geo = result.geo;
        profile.geoError = undefined;
        profile.fingerprint = applyGeo(profile.fingerprint, result.geo);
      } else {
        profile.geoError = result.error ?? "network check failed";
      }
      await saveProfile(profile);
      return { check: result, profile: profileResponse(profile) };
    } finally {
      if (startedVpn && !isActive(profile.id)) {
        await stopVpn(profile.id).catch(() => {});
      }
    }
  });

  /** Ad-hoc proxy test for the create/edit form (nothing is persisted). */
  app.post("/api/proxy/check", async (req) => {
    const body = (req.body ?? {}) as { proxy?: unknown };
    const proxy =
      body.proxy === null || body.proxy === undefined ? undefined : parseProxy(body.proxy);
    return { check: await checkProxy(proxy) };
  });
};
