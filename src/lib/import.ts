import fs from "node:fs";
import type {
  Fingerprint,
  GeoInfo,
  OsProfile,
  Profile,
  ProxyCheckResult,
} from "../types.js";
import { DEFAULT_START_URL } from "../config.js";
import { generateFingerprint, chromeVersion } from "./fingerprint.js";
import { canonicalTimezone, isValidTimezone } from "./geo-locale.js";
import { newId } from "../util/random.js";
import { userDataDirFor } from "../store.js";
import { HttpError, parseProfileInput, parseProxy, parseVpn } from "../server/validate.js";

export const MAX_IMPORT_PROFILES = 500;

export interface ImportedProfile {
  profile: Profile;
  /** Original id from the export/backup, used to link browser data. */
  sourceId?: string;
  warnings: string[];
}

export interface SkippedProfile {
  name: string;
  reason: string;
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return undefined;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) return undefined;
  return trimmed;
}

function isoDate(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 40) return fallback;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return fallback;
  return new Date(ms).toISOString();
}

function optionalIsoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function canonicalLocale(value: unknown): string | undefined {
  const raw = text(value, 35);
  if (!raw) return undefined;
  try {
    return Intl.getCanonicalLocales(raw)[0];
  } catch {
    return undefined;
  }
}

function timezone(value: unknown): string | undefined {
  const raw = text(value, 64);
  if (!raw || !isValidTimezone(raw)) return undefined;
  return canonicalTimezone(raw);
}

function osProfile(value: unknown, fallback: OsProfile): OsProfile {
  return value === "native" || value === "windows" || value === "macos" ? value : fallback;
}

function numberIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined;
}

function integerIn(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : undefined;
}

function sanitizeScreen(
  value: unknown,
  fallback: { width: number; height: number },
): { width: number; height: number } {
  const screen = record(value);
  if (!screen) return fallback;
  const width = integerIn(screen.width, 200, 10_000);
  const height = integerIn(screen.height, 200, 10_000);
  return width && height ? { width, height } : fallback;
}

function sanitizeGeo(value: unknown, now: string): GeoInfo | undefined {
  const geo = record(value);
  if (!geo) return undefined;
  const ip = text(geo.ip, 64);
  if (!ip) return undefined;

  const countryCode = text(geo.countryCode, 2)?.toUpperCase() ?? "";
  return {
    ip,
    country: text(geo.country, 120) ?? "",
    countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : "",
    region: text(geo.region, 120) ?? "",
    city: text(geo.city, 120) ?? "",
    timezone: timezone(geo.timezone) ?? "",
    isp: text(geo.isp, 160) ?? "",
    org: text(geo.org, 160) ?? "",
    checkedAt: isoDate(geo.checkedAt, now),
    provider: text(geo.provider, 40),
    latencyMs: numberIn(geo.latencyMs, 0, 600_000),
  };
}

function sanitizeCheck(value: unknown, now: string): ProxyCheckResult | undefined {
  const check = record(value);
  if (!check || typeof check.ok !== "boolean") return undefined;
  return {
    ok: check.ok,
    checkedAt: isoDate(check.checkedAt, now),
    latencyMs: numberIn(check.latencyMs, 0, 600_000),
    geo: sanitizeGeo(check.geo, now),
    error: text(check.error, 1000),
  };
}

/**
 * Keep a fingerprint from an export when it is structurally valid. Importing a
 * session is only useful if the browser keeps the same identity, so the seed
 * and UA are preserved instead of being regenerated from the new profile id.
 */
function sanitizeFingerprint(
  value: Record<string, unknown> | null,
  fallback: Fingerprint,
): Fingerprint {
  if (!value) return fallback;

  const fp: Fingerprint = {
    osProfile: osProfile(value.osProfile, fallback.osProfile),
    userAgent: text(value.userAgent, 512) ?? fallback.userAgent,
    chromeVersion: /^\d{2,4}\.\d+\.\d+\.\d+$/.test(String(value.chromeVersion ?? ""))
      ? String(value.chromeVersion)
      : fallback.chromeVersion,
    platform: text(value.platform, 32) ?? fallback.platform,
    locale: canonicalLocale(value.locale) ?? fallback.locale,
    timezone: timezone(value.timezone) ?? fallback.timezone,
    screen: sanitizeScreen(value.screen, fallback.screen),
    deviceScaleFactor: numberIn(value.deviceScaleFactor, 0.5, 10) ?? fallback.deviceScaleFactor,
    colorScheme:
      value.colorScheme === "light" || value.colorScheme === "dark"
        ? value.colorScheme
        : fallback.colorScheme,
    seed: text(value.seed, 128) ?? fallback.seed,
    localePinned:
      typeof value.localePinned === "boolean" ? value.localePinned : fallback.localePinned,
    timezonePinned:
      typeof value.timezonePinned === "boolean"
        ? value.timezonePinned
        : fallback.timezonePinned,
  };

  const vendor = text(value.webglVendor, 256);
  const renderer = text(value.webglRenderer, 256);
  if (vendor && renderer) {
    fp.webglVendor = vendor;
    fp.webglRenderer = renderer;
  } else if (fallback.webglVendor && fallback.webglRenderer) {
    fp.webglVendor = fallback.webglVendor;
    fp.webglRenderer = fallback.webglRenderer;
  }

  const hardware = integerIn(value.hardwareConcurrency, 1, 128);
  if (hardware !== undefined) fp.hardwareConcurrency = hardware;
  else if (fallback.hardwareConcurrency !== undefined) {
    fp.hardwareConcurrency = fallback.hardwareConcurrency;
  }

  const memory = numberIn(value.deviceMemory, 0.5, 1024);
  if (memory !== undefined) fp.deviceMemory = memory;
  else if (fallback.deviceMemory !== undefined) fp.deviceMemory = fallback.deviceMemory;

  return fp;
}

/**
 * Convert one untrusted profile from an export/backup into a new local profile.
 * IDs and user-data paths are always assigned locally; imported payloads cannot
 * choose where files are written.
 */
export function importProfile(value: unknown): ImportedProfile {
  const input = record(value);
  if (!input) throw new HttpError(400, "profile must be an object");

  const now = new Date().toISOString();
  const sourceId =
    typeof input.id === "string" && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id : undefined;
  const warnings: string[] = [];

  const common = parseProfileInput(
    {
      name: input.name,
      notes: input.notes,
      tags: input.tags,
      startUrl: input.startUrl,
    },
    { requireName: true },
  );

  let proxy;
  if (input.proxy !== undefined && input.proxy !== null) {
    proxy = parseProxy(input.proxy);
  }

  let vpn;
  if (input.vpn !== undefined && input.vpn !== null) {
    vpn = parseVpn(input.vpn, "vpn", { mustExist: false, resolve: false });
    if (!fs.existsSync(vpn.configPath)) {
      warnings.push(
        `VPN config is not present on this machine (${vpn.configPath}); launch will fail until it is fixed.`,
      );
    }
  }

  const rawFp = record(input.fingerprint);
  const seed = text(rawFp?.seed, 128) ?? newId();
  const fallback = generateFingerprint({
    seed,
    osProfile: osProfile(rawFp?.osProfile, "native"),
    locale: canonicalLocale(rawFp?.locale),
    timezone: timezone(rawFp?.timezone),
    pinLocale: rawFp?.localePinned === true,
    pinTimezone: rawFp?.timezonePinned === true,
  });
  const fingerprint = sanitizeFingerprint(rawFp, fallback);
  if (!rawFp) warnings.push("Fingerprint was regenerated because the export did not include one.");
  const installedChrome = chromeVersion();
  if (
    rawFp &&
    installedChrome &&
    fingerprint.chromeVersion !== installedChrome
  ) {
    warnings.push(
      `Fingerprint Chrome ${fingerprint.chromeVersion} differs from installed Chrome ${installedChrome}; regenerate the fingerprint after verifying the change.`,
    );
  }

  const id = newId();
  const createdAt = isoDate(input.createdAt, now);
  const profile: Profile = {
    id,
    name: common.name!,
    notes: common.notes ?? undefined,
    tags: common.tags ?? [],
    createdAt,
    updatedAt: isoDate(input.updatedAt, createdAt),
    userDataDir: userDataDirFor(id),
    startUrl: common.startUrl ?? DEFAULT_START_URL,
    proxy,
    vpn,
    fingerprint,
    geo: sanitizeGeo(input.geo, now),
    geoError: text(input.geoError, 1000),
    lastLaunchedAt: optionalIsoDate(input.lastLaunchedAt),
    lastCheck: sanitizeCheck(input.lastCheck, now),
  };

  return { profile, sourceId, warnings };
}

/** Accept the dashboard export shape, a raw array, or a `profiles.json` store. */
export function parseImportPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    if (value.length > MAX_IMPORT_PROFILES) {
      throw new HttpError(400, `at most ${MAX_IMPORT_PROFILES} profiles can be imported at once`);
    }
    return value;
  }

  const root = record(value);
  if (!root) throw new HttpError(400, "import payload must be a JSON object or array");

  if (root.format !== undefined && root.format !== "virtual-browser/export") {
    throw new HttpError(400, "unsupported export format");
  }
  if (root.version !== undefined && root.version !== 1) {
    throw new HttpError(400, "unsupported export version");
  }
  if (!Array.isArray(root.profiles)) {
    throw new HttpError(400, "import payload must contain a profiles array");
  }
  if (root.profiles.length > MAX_IMPORT_PROFILES) {
    throw new HttpError(400, `at most ${MAX_IMPORT_PROFILES} profiles can be imported at once`);
  }
  return root.profiles;
}

export function skippedName(value: unknown): string {
  const input = record(value);
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  return name.slice(0, 80) || "(unnamed)";
}
