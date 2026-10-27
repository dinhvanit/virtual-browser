import fs from "node:fs";
import path from "node:path";

export const VERSION = "0.2.0";

export const ROOT = process.cwd();
export const DATA_DIR = process.env.VB_DATA_DIR
  ? path.resolve(process.env.VB_DATA_DIR)
  : path.join(ROOT, "data");
export const PROFILES_DIR = path.join(DATA_DIR, "profiles");
export const WG_DIR = path.join(DATA_DIR, "wg");
export const STORE_FILE = path.join(DATA_DIR, "profiles.json");

export const HOST = process.env.VB_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.VB_PORT ?? 8787);

export const PUBLIC_DIR = path.join(ROOT, "public");

/**
 * Chrome is driven through playwright-core, but we deliberately use the
 * *installed* Chrome instead of a bundled Chromium: real Chrome has the
 * proprietary codecs, the "Google Chrome" brand in client hints and is the
 * browser most anti-fraud systems compare against.
 */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/opt/google/chrome/chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].filter(Boolean) as string[];

export const CHROME_PATH =
  CHROME_CANDIDATES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }) ?? "";

export const WIREPROXY_PATH = (() => {
  const candidates = [
    process.env.VB_WIREPROXY,
    "/usr/local/bin/wireproxy",
    "/usr/bin/wireproxy",
    path.join(ROOT, "bin", "wireproxy"),
  ].filter(Boolean) as string[];
  return (
    candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    }) ?? ""
  );
})();

/**
 * Headed by default: headless Chrome exposes a different fingerprint (no
 * GPU blocklist quirks, no window sizing) which defeats the point of the
 * tool. Set VB_HEADLESS=1 for CI/smoke tests.
 */
export const HEADLESS = process.env.VB_HEADLESS === "1";

/** Neutral landing page; cheap to load, always up, shows the exit IP works. */
export const DEFAULT_START_URL =
  process.env.VB_START_URL ?? "https://example.com/";

/** Frames per second the dashboard thumbnail may consume. */
export const SCREENCAST = {
  quality: 45,
  maxWidth: 420,
  everyNthFrame: 4,
};

/**
 * How long to wait for an exit-node geolocation lookup before launching with
 * the profile's own locale/timezone.
 */
export const GEO_TIMEOUT_MS = Number(process.env.VB_GEO_TIMEOUT_MS ?? 9000);

/** Upper bound for `wireproxy` to open its local SOCKS5 port. */
export const VPN_BOOT_TIMEOUT_MS = Number(
  process.env.VB_VPN_BOOT_TIMEOUT_MS ?? 10000,
);
