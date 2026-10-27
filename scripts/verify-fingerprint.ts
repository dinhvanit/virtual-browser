/**
 * Headless verification that the generated fingerprint is what the page sees.
 *
 *   npx tsx scripts/verify-fingerprint.ts
 *
 * Exits non-zero if the browser disagrees with the generated fingerprint.
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { CHROME_PATH } from "../src/config.js";
import {
  acceptLanguage,
  fingerprintInitScript,
  generateFingerprint,
  userAgentMetadata,
} from "../src/lib/fingerprint.js";

async function main(): Promise<void> {
  if (!CHROME_PATH) throw new Error("Chrome not found; set CHROME_PATH");
  const fp = generateFingerprint({ seed: "verify-fingerprint", osProfile: "windows" });
  const dir = path.join("/tmp/opencode", `vb-verify-${Date.now()}`);

  const context = await chromium.launchPersistentContext(dir, {
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    userAgent: fp.userAgent,
    locale: fp.locale,
    timezoneId: fp.timezone,
    viewport: { width: fp.screen.width, height: fp.screen.height },
    screen: { width: fp.screen.width, height: fp.screen.height },
    deviceScaleFactor: fp.deviceScaleFactor,
    extraHTTPHeaders: { "Accept-Language": acceptLanguage(fp.locale) },
  });

  try {
    await context.addInitScript({ content: fingerprintInitScript(fp) });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });

    const observed = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl");
      const debug = gl?.getExtension("WEBGL_debug_renderer_info");
      const high = await navigator.userAgentData?.getHighEntropyValues([
        "platformVersion",
        "uaFullVersion",
        "fullVersionList",
        "architecture",
      ]);
      return {
        userAgent: navigator.userAgent,
        webdriver: navigator.webdriver,
        platform: navigator.platform,
        language: navigator.language,
        languages: navigator.languages,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
        uaDataPlatform: navigator.userAgentData?.platform,
        uaDataBrands: navigator.userAgentData?.brands,
        uaDataHigh: high,
        chromeRuntime: Boolean(window.chrome?.runtime),
        screen: {
          width: window.screen.width,
          height: window.screen.height,
          dpr: window.devicePixelRatio,
        },
        webgl: {
          vendor: gl?.getParameter(37445),
          renderer: gl?.getParameter(37446),
          debugVendor: debug ? gl?.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
          debugRenderer: debug ? gl?.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        },
      };
    });

    const expected = {
      userAgent: fp.userAgent,
      webdriver: false,
      platform: fp.platform,
      language: fp.locale,
      languages: [fp.locale, ...(fp.locale.includes("-") ? [fp.locale.split("-")[0]] : [])],
      hardwareConcurrency: fp.hardwareConcurrency,
      deviceMemory: fp.deviceMemory,
      timezone: fp.timezone,
      uaDataPlatform: userAgentMetadata(fp).platform,
      chromeRuntime: true,
      screen: {
        width: fp.screen.width,
        height: fp.screen.height,
        dpr: fp.deviceScaleFactor,
      },
      webgl: {
        vendor: fp.webglVendor,
        renderer: fp.webglRenderer,
        debugVendor: fp.webglVendor,
        debugRenderer: fp.webglRenderer,
      },
    };

    console.log("generated fingerprint:", JSON.stringify(fp, null, 2));
    console.log("observed in page:      ", JSON.stringify(observed, null, 2));

    const mismatches: string[] = [];
    const check = (label: string, actual: unknown, want: unknown) => {
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        mismatches.push(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
      }
    };

    check("navigator.userAgent", observed.userAgent, expected.userAgent);
    check("navigator.webdriver", observed.webdriver, expected.webdriver);
    check("navigator.platform", observed.platform, expected.platform);
    check("navigator.language", observed.language, expected.language);
    check("navigator.languages", observed.languages, expected.languages);
    check("navigator.hardwareConcurrency", observed.hardwareConcurrency, expected.hardwareConcurrency);
    check("navigator.deviceMemory", observed.deviceMemory, expected.deviceMemory);
    check("Intl timeZone", observed.timezone, expected.timezone);
    check("userAgentData.platform", observed.uaDataPlatform, expected.uaDataPlatform);
    check("window.chrome.runtime", observed.chromeRuntime, expected.chromeRuntime);
    check("screen", observed.screen, expected.screen);
    check("WebGL vendor", observed.webgl.vendor, expected.webgl.vendor);
    check("WebGL renderer", observed.webgl.renderer, expected.webgl.renderer);
    check("WebGL debug vendor", observed.webgl.debugVendor, expected.webgl.debugVendor);
    check("WebGL debug renderer", observed.webgl.debugRenderer, expected.webgl.debugRenderer);

    if (mismatches.length > 0) {
      console.error("\nFINGERPRINT MISMATCHES:");
      for (const mismatch of mismatches) console.error(` - ${mismatch}`);
      process.exitCode = 1;
      return;
    }
    console.log("\nOK: every checked value matches the generated fingerprint.");
  } finally {
    await context.close().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
