import { execFileSync } from "node:child_process";
import os from "node:os";
import { CHROME_PATH } from "../config.js";
import type { Fingerprint, GeoInfo, OsProfile } from "../types.js";
import { createPicker } from "../util/random.js";
import {
  canonicalTimezone,
  isValidTimezone,
  languageList,
  localeForCountry,
} from "./geo-locale.js";

/* ------------------------------------------------------------------ */
/* Installed Chrome discovery                                          */
/* ------------------------------------------------------------------ */

let cachedVersion: string | null = null;

/**
 * Read the version of the real Chrome binary. The UA and the client hints must
 * match it or the profile is instantly inconsistent (e.g. UA says 150 while
 * `navigator.userAgentData` reports the playwright Chromium build).
 */
export function chromeVersion(): string {
  if (cachedVersion) return cachedVersion;
  cachedVersion = process.env.VB_CHROME_VERSION ?? "";
  if (!cachedVersion && CHROME_PATH) {
    try {
      const out = execFileSync(CHROME_PATH, ["--version"], {
        encoding: "utf8",
        timeout: 5000,
      });
      const match = out.match(/(\d+\.\d+\.\d+\.\d+)/);
      if (match) cachedVersion = match[1]!;
    } catch {
      /* binary missing or not executable; fall through */
    }
  }
  if (!cachedVersion) cachedVersion = "150.0.0.0";
  return cachedVersion;
}

export function chromeMajor(): string {
  return chromeVersion().split(".")[0] ?? "150";
}

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

const LOCALES = [
  { locale: "en-US", timezone: "America/New_York" },
  { locale: "en-GB", timezone: "Europe/London" },
  { locale: "de-DE", timezone: "Europe/Berlin" },
  { locale: "fr-FR", timezone: "Europe/Paris" },
  { locale: "es-ES", timezone: "Europe/Madrid" },
  { locale: "pt-BR", timezone: "America/Sao_Paulo" },
  { locale: "ja-JP", timezone: "Asia/Tokyo" },
  { locale: "vi-VN", timezone: "Asia/Ho_Chi_Minh" },
] as const;

const SCREENS: Record<"windows" | "macos" | "native", Array<{ width: number; height: number }>> = {
  windows: [
    { width: 1920, height: 1080 },
    { width: 1536, height: 864 },
    { width: 2560, height: 1440 },
    { width: 1366, height: 768 },
  ],
  macos: [
    { width: 1512, height: 982 },
    { width: 1440, height: 900 },
    { width: 1728, height: 1117 },
    { width: 1680, height: 1050 },
  ],
  native: [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 2560, height: 1440 },
  ],
};

const WEBGL: Record<"windows" | "macos", Array<{ vendor: string; renderer: string }>> = {
  windows: [
    {
      vendor: "Google Inc. (NVIDIA)",
      renderer:
        "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    },
    {
      vendor: "Google Inc. (Intel)",
      renderer:
        "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    },
    {
      vendor: "Google Inc. (AMD)",
      renderer:
        "ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
    },
  ],
  macos: [
    {
      vendor: "Google Inc. (Apple)",
      renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
    },
    {
      vendor: "Google Inc. (Apple)",
      renderer:
        "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)",
    },
    {
      vendor: "Google Inc. (Intel Inc.)",
      renderer: "ANGLE (Intel Inc., Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)",
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

export interface GenerateInput {
  /** Stable seed; normally the profile id. */
  seed: string;
  osProfile?: OsProfile;
  locale?: string;
  timezone?: string;
  /** Preserve the explicit locale/timezone instead of following the exit IP. */
  pinLocale?: boolean;
  pinTimezone?: boolean;
}

function userAgentFor(osProfile: OsProfile, version: string): string {
  const tail = `AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  if (osProfile === "windows") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${tail}`;
  }
  if (osProfile === "macos") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${tail}`;
  }
  if (process.platform === "win32") {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) ${tail}`;
  }
  if (process.platform === "darwin") {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ${tail}`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) ${tail}`;
}

function platformFor(osProfile: OsProfile): string {
  if (osProfile === "windows") return "Win32";
  if (osProfile === "macos") return "MacIntel";
  if (process.platform === "win32") return "Win32";
  if (process.platform === "darwin") return "MacIntel";
  return "Linux x86_64";
}

/**
 * Produce a complete, self-consistent fingerprint. Values that a website can
 * cross-check (UA version vs. client hints, screen vs. DPR, platform vs. WebGL
 * driver) all come from one seeded picker so they never contradict each other.
 */
export function generateFingerprint(input: GenerateInput): Fingerprint {
  const osProfile = input.osProfile ?? "native";
  const picker = createPicker(input.seed);
  const version = chromeVersion();
  const seededLocale = picker.pick(LOCALES);
  const systemLocale =
    typeof Intl !== "undefined"
      ? new Intl.DateTimeFormat().resolvedOptions().locale
      : "en-US";
  const systemTimezone =
    typeof Intl !== "undefined"
      ? new Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC";

  const locale = input.locale ?? (osProfile === "native" ? systemLocale : seededLocale.locale);
  const timezone = canonicalTimezone(
    input.timezone ?? (osProfile === "native" ? systemTimezone : seededLocale.timezone),
  );
  const screen = picker.pick(SCREENS[osProfile]);

  const fingerprint: Fingerprint = {
    osProfile,
    userAgent: userAgentFor(osProfile, version),
    chromeVersion: version,
    platform: platformFor(osProfile),
    locale,
    timezone,
    screen,
    deviceScaleFactor:
      osProfile === "macos" ? picker.pick([2, 2, 1]) : picker.pick([1, 1, 1.25]),
    colorScheme: picker.chance(0.15) ? "dark" : "light",
    seed: input.seed,
    hardwareConcurrency: picker.pick([8, 12, 16]),
    deviceMemory: picker.pick([8, 8, 16]),
    localePinned: input.pinLocale ?? Boolean(input.locale),
    timezonePinned: input.pinTimezone ?? Boolean(input.timezone),
  };

  if (osProfile !== "native") {
    const gpu = picker.pick(WEBGL[osProfile]);
    fingerprint.webglVendor = gpu.vendor;
    fingerprint.webglRenderer = gpu.renderer;
  }

  return fingerprint;
}

/**
 * Fold the exit-node geo into the stored fingerprint. Timezone/locale must
 * follow the IP — a German IP with an en-US locale and America/New_York clock
 * is one of the cheapest signals there is.
 */
export function applyGeo(fingerprint: Fingerprint, geo: GeoInfo | undefined): Fingerprint {
  if (!geo) return fingerprint;
  const locale = localeForCountry(geo.countryCode);
  const timezone = isValidTimezone(geo.timezone)
    ? canonicalTimezone(geo.timezone)
    : undefined;
  if (!locale && !timezone) return fingerprint;
  return {
    ...fingerprint,
    locale: fingerprint.localePinned ? fingerprint.locale : locale ?? fingerprint.locale,
    timezone: fingerprint.timezonePinned
      ? fingerprint.timezone
      : timezone ?? fingerprint.timezone,
  };
}

/* ------------------------------------------------------------------ */
/* Browser-facing data                                                 */
/* ------------------------------------------------------------------ */

export function acceptLanguage(locale: string): string {
  const [base] = locale.split("-");
  if (!base || base === locale) return locale;
  return `${locale},${base};q=0.9`;
}

export function userAgentMetadata(fp: Fingerprint) {
  const major = fp.chromeVersion.split(".")[0] ?? "150";
  const full = fp.chromeVersion;
  const brands = [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
    { brand: "Not-A.Brand", version: "24" },
  ];
  const platform =
    fp.osProfile === "windows"
      ? "Windows"
      : fp.osProfile === "macos"
        ? "macOS"
        : process.platform === "win32"
          ? "Windows"
          : process.platform === "darwin"
            ? "macOS"
            : "Linux";

  return {
    brands,
    fullVersionList: [
      { brand: "Chromium", version: full },
      { brand: "Google Chrome", version: full },
      { brand: "Not-A.Brand", version: "24.0.0.0" },
    ],
    fullVersion: full,
    platform,
    platformVersion:
      platform === "Windows" ? "15.0.0" : platform === "macOS" ? "14.5.0" : "6.6.0",
    architecture: "x86",
    model: "",
    mobile: false,
    bitness: "64",
    wow64: false,
  };
}

/**
 * Init script applied to every frame. Covers the JS-observable surface:
 * navigator, WebGL, plugins, chrome runtime. Headers are handled separately by
 * CDP `Emulation.setUserAgentOverride` (see runtime.ts).
 */
export function fingerprintInitScript(fp: Fingerprint): string {
  const cfg = {
    userAgent: fp.userAgent,
    appVersion: fp.userAgent.replace(/^Mozilla\//, ""),
    platform: fp.platform,
    locale: fp.locale,
    languages: languageList(fp.locale),
    hardwareConcurrency: fp.hardwareConcurrency ?? os.cpus().length,
    deviceMemory: fp.deviceMemory ?? Math.max(8, Math.round(os.totalmem() / 1024 ** 3)),
    vendor: fp.webglVendor,
    renderer: fp.webglRenderer,
    brands: userAgentMetadata(fp).brands,
    fullVersionList: userAgentMetadata(fp).fullVersionList,
    uaPlatform: userAgentMetadata(fp).platform,
    chromeVersion: fp.chromeVersion,
  };

  return `(() => {
  const cfg = ${JSON.stringify(cfg)};
  const define = (target, prop, value) => {
    try {
      Object.defineProperty(target, prop, { get: () => value, configurable: true });
    } catch (_) { /* ignore */ }
  };

  define(Navigator.prototype, "webdriver", false);
  define(Navigator.prototype, "platform", cfg.platform);
  define(Navigator.prototype, "hardwareConcurrency", cfg.hardwareConcurrency);
  define(Navigator.prototype, "deviceMemory", cfg.deviceMemory);
  define(Navigator.prototype, "language", cfg.locale);
  define(Navigator.prototype, "languages", Object.freeze(cfg.languages.slice()));
  define(Navigator.prototype, "userAgent", cfg.userAgent);
  define(Navigator.prototype, "appVersion", cfg.appVersion);
  define(Navigator.prototype, "vendor", "Google Inc.");

  // --- client hints -------------------------------------------------
  const uaData = {
    brands: Object.freeze(cfg.brands.map((b) => Object.freeze({ ...b }))),
    mobile: false,
    platform: cfg.uaPlatform,
    getHighEntropyValues: async (hints) => {
      const high = {
        architecture: "x86",
        bitness: "64",
        brands: cfg.brands,
        fullVersionList: cfg.fullVersionList,
        mobile: false,
        model: "",
        platform: cfg.uaPlatform,
        platformVersion: cfg.uaPlatform === "Windows" ? "15.0.0" : cfg.uaPlatform === "macOS" ? "14.5.0" : "6.6.0",
        uaFullVersion: cfg.chromeVersion,
        wow64: false,
      };
      const out = { brands: uaData.brands, mobile: false, platform: uaData.platform };
      for (const hint of hints || []) {
        if (hint in high) out[hint] = high[hint];
      }
      return out;
    },
    toJSON: () => ({ brands: cfg.brands, mobile: false, platform: cfg.uaPlatform }),
  };
  define(Navigator.prototype, "userAgentData", Object.freeze(uaData));

  // --- window.chrome ------------------------------------------------
  if (!window.chrome) define(window, "chrome", {});
  if (!window.chrome.runtime) window.chrome.runtime = {};
  if (!window.chrome.app) window.chrome.app = { isInstalled: false };

  // --- plugins (PDF viewer trio, as in desktop Chrome) --------------
  const pluginNames = ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"];
  const plugins = pluginNames.map((name) => ({ name, filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1 }));
  define(Navigator.prototype, "plugins", Object.freeze(plugins));
  define(Navigator.prototype, "mimeTypes", Object.freeze([{ type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" }]));

  // --- WebGL ---------------------------------------------------------
  if (cfg.vendor && cfg.renderer) {
    const patch = (proto) => {
      if (!proto) return;
      const original = proto.getParameter;
      proto.getParameter = function (parameter) {
        if (parameter === 37445) return cfg.vendor;
        if (parameter === 37446) return cfg.renderer;
        return original.call(this, parameter);
      };
    };
    patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
    const debugInfo = (proto) => {
      if (!proto || !proto.getExtension) return;
      const original = proto.getExtension;
      proto.getExtension = function (name) {
        const ext = original.call(this, name);
        if (ext && name === "WEBGL_debug_renderer_info") {
          try {
            Object.defineProperty(ext, "UNMASKED_VENDOR_WEBGL", { get: () => 37445 });
            Object.defineProperty(ext, "UNMASKED_RENDERER_WEBGL", { get: () => 37446 });
          } catch (_) { /* ignore */ }
        }
        return ext;
      };
    };
    debugInfo(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
    debugInfo(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  }

  // --- notification permission stays at Chrome's default "prompt" ---
})();`;
}
