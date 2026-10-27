import type { GeoInfo, ProxyCheckResult, ProxyConfig } from "../types.js";
import { getViaProxy } from "./upstream.js";

interface ProviderResult {
  provider: string;
  geo: GeoInfo;
}

function now(): string {
  return new Date().toISOString();
}

async function lookupIpWhoIs(proxy: ProxyConfig | undefined, timeout: number): Promise<ProviderResult> {
  const { status, body, latencyMs } = await getViaProxy(
    proxy,
    "https://ipwho.is/?fields=success,ip,country,country_code,region,city,timezone,connection",
    { timeout },
  );
  if (status !== 200) throw new Error(`ipwho.is returned HTTP ${status}`);
  const data = JSON.parse(body) as {
    success?: boolean;
    message?: string;
    ip?: string;
    country?: string;
    country_code?: string;
    region?: string;
    city?: string;
    timezone?: { id?: string };
    connection?: { isp?: string; org?: string };
  };
  if (data.success === false) throw new Error(data.message || "ipwho.is lookup failed");
  if (!data.ip) throw new Error("ipwho.is returned no IP");

  return {
    provider: "ipwho.is",
    geo: {
      ip: data.ip,
      country: data.country ?? "",
      countryCode: data.country_code ?? "",
      region: data.region ?? "",
      city: data.city ?? "",
      timezone: data.timezone?.id ?? "",
      isp: data.connection?.isp ?? "",
      org: data.connection?.org ?? "",
      checkedAt: now(),
      provider: "ipwho.is",
      latencyMs,
    },
  };
}

async function lookupIpApiCo(proxy: ProxyConfig | undefined, timeout: number): Promise<ProviderResult> {
  const { status, body, latencyMs } = await getViaProxy(proxy, "https://ipapi.co/json/", {
    timeout,
  });
  if (status !== 200) throw new Error(`ipapi.co returned HTTP ${status}`);
  const data = JSON.parse(body) as {
    error?: boolean;
    reason?: string;
    ip?: string;
    city?: string;
    region?: string;
    country_name?: string;
    country_code?: string;
    timezone?: string;
    org?: string;
  };
  if (data.error) throw new Error(data.reason || "ipapi.co lookup failed");
  if (!data.ip) throw new Error("ipapi.co returned no IP");

  return {
    provider: "ipapi.co",
    geo: {
      ip: data.ip,
      country: data.country_name ?? "",
      countryCode: data.country_code ?? "",
      region: data.region ?? "",
      city: data.city ?? "",
      timezone: data.timezone ?? "",
      isp: data.org ?? "",
      org: data.org ?? "",
      checkedAt: now(),
      provider: "ipapi.co",
      latencyMs,
    },
  };
}

/**
 * Resolve the exit IP and its geolocation through the given proxy (or
 * directly when none is configured). Tries two independent providers so a
 * single outage does not block a launch.
 */
export async function lookupGeo(
  proxy: ProxyConfig | undefined,
  timeout = 9000,
): Promise<GeoInfo> {
  const deadline = Date.now() + timeout;
  const errors: string[] = [];
  for (const lookup of [lookupIpWhoIs, lookupIpApiCo]) {
    const remaining = deadline - Date.now();
    if (remaining < 500) break;
    try {
      const result = await lookup(proxy, remaining);
      return result.geo;
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error(errors.join(" | ") || "geolocation lookup timed out");
}

export async function checkProxy(proxy?: ProxyConfig): Promise<ProxyCheckResult> {
  const started = Date.now();
  try {
    const geo = await lookupGeo(proxy);
    return {
      ok: true,
      checkedAt: now(),
      latencyMs: Date.now() - started,
      geo,
    };
  } catch (err) {
    return {
      ok: false,
      checkedAt: now(),
      latencyMs: Date.now() - started,
      error: (err as Error).message,
    };
  }
}
