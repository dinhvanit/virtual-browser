export type ProxyType = "http" | "https" | "socks5";

export interface ProxyConfig {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Free-form label, e.g. the provider name. */
  label?: string;
}

/** WireGuard tunnel via `wireproxy`. Exposes a local SOCKS5 that Chrome can use. */
export interface VpnConfig {
  kind: "wireguard";
  configPath: string;
}

export type OsProfile = "native" | "windows" | "macos";

export interface Fingerprint {
  osProfile: OsProfile;
  userAgent: string;
  /** Full Chrome version, used for Client Hints when spoofing a foreign OS. */
  chromeVersion: string;
  /** navigator.platform override, e.g. "Win32". */
  platform: string;
  locale: string;
  timezone: string;
  screen: { width: number; height: number };
  deviceScaleFactor: number;
  /** Only applied when osProfile !== "native". */
  webglVendor?: string;
  webglRenderer?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  colorScheme: "light" | "dark";
  /** Deterministic seed the whole fingerprint was generated from. */
  seed?: string;
  /** When true, the exit-IP geo must not overwrite the chosen locale. */
  localePinned?: boolean;
  /** When true, the exit-IP geo must not overwrite the chosen timezone. */
  timezonePinned?: boolean;
}

export interface GeoInfo {
  ip: string;
  country: string;
  countryCode: string;
  region: string;
  city: string;
  timezone: string;
  isp: string;
  org: string;
  checkedAt: string;
  /** Which provider answered (ipwho.is / ipapi.co ...). */
  provider?: string;
  latencyMs?: number;
}

export interface ProxyCheckResult {
  ok: boolean;
  checkedAt: string;
  latencyMs?: number;
  geo?: GeoInfo;
  error?: string;
}

export interface Profile {
  id: string;
  name: string;
  notes?: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  userDataDir: string;
  startUrl: string;
  proxy?: ProxyConfig;
  vpn?: VpnConfig;
  fingerprint: Fingerprint;
  /** Exit-node geolocation, used to derive timezone/locale. */
  geo?: GeoInfo;
  geoError?: string;
  lastLaunchedAt?: string;
  lastCheck?: ProxyCheckResult;
}

export type RuntimeState = "stopped" | "starting" | "running" | "error";

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export interface RuntimeStatus {
  profileId: string;
  state: RuntimeState;
  pid?: number;
  startedAt?: string;
  error?: string;
  url?: string;
  title?: string;
  tabs?: TabInfo[];
  /** Whether the dashboard thumbnail feed is alive. */
  streaming?: boolean;
  proxyServer?: string;
  vpnActive?: boolean;
}

export interface ProfileWithStatus extends Profile {
  runtime: RuntimeStatus;
}

/** Effective connection used for a launch (direct, proxy or VPN). */
export interface EffectiveNetwork {
  proxy?: ProxyConfig;
  vpnPort?: number;
  relayPort?: number;
  label: string;
}
