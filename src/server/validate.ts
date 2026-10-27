import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OsProfile, ProxyConfig, ProxyType, VpnConfig } from "../types.js";
import { isValidTimezone } from "../lib/geo-locale.js";

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export function badRequest(message: string): never {
  throw new HttpError(400, message);
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    badRequest(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(
  value: unknown,
  field: string,
  opts: { max?: number; allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") badRequest(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed && !opts.allowEmpty) badRequest(`${field} must not be empty`);
  if (opts.max && trimmed.length > opts.max) {
    badRequest(`${field} must be at most ${opts.max} characters`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(trimmed)) {
    badRequest(`${field} contains control characters`);
  }
  return trimmed;
}

export function parseProxy(value: unknown, field = "proxy"): ProxyConfig {
  const input = asObject(value, field);
  const types: ProxyType[] = ["http", "https", "socks5"];
  const type = input.type;
  if (typeof type !== "string" || !types.includes(type as ProxyType)) {
    badRequest(`${field}.type must be one of ${types.join(", ")}`);
  }

  let host = stringField(input.host, `${field}.host`, { max: 255 });
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    badRequest(`${field}.host must not include a scheme`);
  }
  host = host.replace(/^\[|\]$/g, "");

  const portRaw = input.port;
  const port = typeof portRaw === "number" ? portRaw : Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    badRequest(`${field}.port must be an integer between 1 and 65535`);
  }

  const proxy: ProxyConfig = { type: type as ProxyType, host, port };

  if (input.username !== undefined && input.username !== null) {
    const username = stringField(input.username, `${field}.username`, {
      max: 255,
      allowEmpty: true,
    });
    if (username) proxy.username = username;
  }
  if (input.password !== undefined && input.password !== null) {
    const password = stringField(input.password, `${field}.password`, {
      max: 512,
      allowEmpty: true,
    });
    if (password) proxy.password = password;
  }
  if (input.label !== undefined && input.label !== null) {
    const label = stringField(input.label, `${field}.label`, { max: 64, allowEmpty: true });
    if (label) proxy.label = label;
  }

  return proxy;
}

function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~" + path.sep)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function parseVpn(
  value: unknown,
  field = "vpn",
  opts: { mustExist?: boolean; resolve?: boolean } = {},
): VpnConfig {
  const input = asObject(value, field);
  const kind = input.kind ?? "wireguard";
  if (kind !== "wireguard") badRequest(`${field}.kind must be "wireguard"`);
  const raw = stringField(input.configPath, `${field}.configPath`, { max: 4096 });
  const mustExist = opts.mustExist ?? true;
  const resolve = opts.resolve ?? true;
  // Imports may come from another OS/machine: keep the original path instead
  // of turning "C:\\..." into a Linux-relative path.
  const configPath = resolve ? path.resolve(expandHome(raw)) : raw;
  if (mustExist && !fs.existsSync(configPath)) {
    badRequest(`${field}.configPath does not exist: ${configPath}`);
  }
  return { kind: "wireguard", configPath };
}

export interface ProfileInput {
  name?: string;
  notes?: string | null;
  tags?: string[];
  startUrl?: string;
  proxy?: ProxyConfig | null;
  vpn?: VpnConfig | null;
  osProfile?: OsProfile;
  locale?: string | null;
  timezone?: string | null;
}

export function parseProfileInput(
  value: unknown,
  opts: { requireName: boolean },
): ProfileInput {
  const input = asObject(value, "body");
  const result: ProfileInput = {};

  if (input.name !== undefined || opts.requireName) {
    result.name = stringField(input.name, "name", { max: 80 });
  }

  if (input.notes !== undefined) {
    if (input.notes === null) result.notes = null;
    else result.notes = stringField(input.notes, "notes", { max: 8000, allowEmpty: true });
  }

  if (input.tags !== undefined) {
    if (input.tags === null) result.tags = [];
    else if (!Array.isArray(input.tags)) badRequest("tags must be an array of strings");
    else {
      const tags: string[] = [];
      for (const tag of input.tags) {
        const clean = stringField(tag, "tags[]", { max: 32 });
        if (!tags.some((t) => t.toLowerCase() === clean.toLowerCase())) tags.push(clean);
      }
      if (tags.length > 20) badRequest("at most 20 tags are allowed");
      result.tags = tags;
    }
  }

  if (input.startUrl !== undefined) {
    const raw = stringField(input.startUrl, "startUrl", { max: 2048 });
    if (raw !== "about:blank") {
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        badRequest("startUrl must be a valid absolute URL (https://...)");
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        badRequest("startUrl must use http or https");
      }
    }
    result.startUrl = raw;
  }

  if (input.proxy !== undefined) {
    result.proxy = input.proxy === null ? null : parseProxy(input.proxy);
  }

  if (input.vpn !== undefined) {
    result.vpn = input.vpn === null ? null : parseVpn(input.vpn);
  }

  if (input.osProfile !== undefined) {
    const allowed: OsProfile[] = ["native", "windows", "macos"];
    if (typeof input.osProfile !== "string" || !allowed.includes(input.osProfile as OsProfile)) {
      badRequest(`osProfile must be one of ${allowed.join(", ")}`);
    }
    result.osProfile = input.osProfile as OsProfile;
  }

  if (input.locale !== undefined) {
    if (input.locale === null) {
      result.locale = null;
    } else {
      if (typeof input.locale !== "string") badRequest("locale must be a string");
      try {
        result.locale = Intl.getCanonicalLocales(input.locale.trim())[0];
      } catch {
        badRequest(`locale is not a valid BCP-47 tag: ${input.locale}`);
      }
      if (!result.locale) badRequest("locale must not be empty");
    }
  }

  if (input.timezone !== undefined) {
    if (input.timezone === null) {
      result.timezone = null;
    } else {
      const timezone = stringField(input.timezone, "timezone", { max: 64 });
      if (!isValidTimezone(timezone)) badRequest(`timezone is not a valid IANA zone: ${timezone}`);
      result.timezone = timezone;
    }
  }

  return result;
}

export function parseId(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) badRequest("invalid profile id");
  return value;
}

export function parseIndex(value: string): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) badRequest("tab index must be a non-negative integer");
  return index;
}
