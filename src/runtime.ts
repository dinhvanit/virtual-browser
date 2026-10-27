import {
  chromium,
  type BrowserContext,
  type BrowserType,
  type CDPSession,
  type Page,
} from "playwright-core";
import {
  CHROME_PATH,
  GEO_TIMEOUT_MS,
  HEADLESS,
  SCREENCAST,
} from "./config.js";
import { lookupGeo } from "./lib/geo.js";
import {
  acceptLanguage,
  applyGeo,
  fingerprintInitScript,
  userAgentMetadata,
} from "./lib/fingerprint.js";
import { startRelay, type RelayHandle } from "./lib/relay.js";
import { startVpn, stopAllVpn, stopVpn } from "./lib/vpn.js";
import { getProfile, saveProfile } from "./store.js";
import type {
  Fingerprint,
  Profile,
  ProxyConfig,
  RuntimeStatus,
  TabInfo,
} from "./types.js";

interface Screencast {
  cdp: CDPSession;
  page: Page;
}

type LaunchPersistentContextOptions = Parameters<
  BrowserType["launchPersistentContext"]
>[1];

interface Session {
  profileId: string;
  context: BrowserContext;
  relay?: RelayHandle;
  vpnActive: boolean;
  state: "starting" | "running" | "error";
  startedAt: string;
  error?: string;
  activePage: Page | null;
  screencast: Screencast | null;
  frame: string | null;
  frameAt: number;
  cleaned: boolean;
  proxyServer?: string;
}

const sessions = new Map<string, Session>();

/* ------------------------------------------------------------------ */
/* Fingerprint / launch options                                       */
/* ------------------------------------------------------------------ */

export function effectiveFingerprint(profile: Profile): Fingerprint {
  return applyGeo(profile.fingerprint, profile.geo);
}

function launchArgs(fp: Fingerprint, proxied: boolean): string[] {
  const args = [
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion",
    "--disable-session-crashed-bubble",
    "--hide-crash-restore-bubble",
    "--no-service-autorun",
    "--password-store=basic",
    "--lang=" + fp.locale,
    `--window-size=${fp.screen.width},${fp.screen.height}`,
    "--disable-dev-shm-usage",
  ];
  if (proxied) {
    // Keep WebRTC from bypassing the proxy with the host's real IP.
    args.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp");
  }
  if (process.platform === "linux") args.push("--no-sandbox");
  return args;
}

function contextOptions(fp: Fingerprint, proxyServer?: string): LaunchPersistentContextOptions {
  const options: LaunchPersistentContextOptions = {
    executablePath: CHROME_PATH,
    headless: HEADLESS,
    args: launchArgs(fp, Boolean(proxyServer)),
    ignoreDefaultArgs: ["--enable-automation"],
    userAgent: fp.userAgent,
    locale: fp.locale,
    timezoneId: fp.timezone,
    viewport: { width: fp.screen.width, height: fp.screen.height },
    screen: { width: fp.screen.width, height: fp.screen.height },
    deviceScaleFactor: fp.deviceScaleFactor,
    colorScheme: fp.colorScheme,
    acceptDownloads: true,
    extraHTTPHeaders: { "Accept-Language": acceptLanguage(fp.locale) },
    ignoreHTTPSErrors: false,
  };
  if (proxyServer) options.proxy = { server: proxyServer };
  return options;
}

/** Server-side UA client hints are only complete through CDP. */
async function applyPageOverrides(page: Page, fp: Fingerprint): Promise<void> {
  let cdp: CDPSession | null = null;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: fp.userAgent,
      acceptLanguage: acceptLanguage(fp.locale),
      platform: fp.platform,
      userAgentMetadata: userAgentMetadata(fp),
    });
  } catch {
    /* page closed or CDP unavailable; JS init script still applies */
  } finally {
    await cdp?.detach().catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* Thumbnail stream                                                    */
/* ------------------------------------------------------------------ */

async function stopScreencast(session: Session): Promise<void> {
  const current = session.screencast;
  session.screencast = null;
  if (!current) return;
  try {
    await current.cdp.send("Page.stopScreencast");
  } catch {
    /* already gone */
  }
  await current.cdp.detach().catch(() => {});
}

async function startScreencast(session: Session, page: Page): Promise<void> {
  await stopScreencast(session);
  if (page.isClosed()) return;
  try {
    const cdp = await session.context.newCDPSession(page);
    session.screencast = { cdp, page };
    cdp.on("Page.screencastFrame", (event: { data: string; sessionId: number }) => {
      session.frame = event.data;
      session.frameAt = Date.now();
      void cdp
        .send("Page.screencastFrameAck", { sessionId: event.sessionId })
        .catch(() => {});
    });
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: SCREENCAST.quality,
      maxWidth: SCREENCAST.maxWidth,
      maxHeight: Math.round((SCREENCAST.maxWidth * 3) / 4),
      everyNthFrame: SCREENCAST.everyNthFrame,
    });
  } catch {
    session.screencast = null;
  }
}

async function captureStill(session: Session, page: Page): Promise<void> {
  try {
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 55,
      timeout: 5000,
      scale: "css",
    });
    session.frame = buffer.toString("base64");
    session.frameAt = Date.now();
  } catch {
    /* navigation in progress etc. */
  }
}

/**
 * Start the live view on `page`. Screencast frames arrive asynchronously, so
 * wait briefly and only fall back to a full screenshot when nothing arrived
 * (e.g. a static page in a build without screencast support).
 */
async function startView(session: Session, page: Page): Promise<void> {
  session.frame = null;
  await startScreencast(session, page);
  for (let i = 0; i < 8 && !session.frame; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!session.frame) await captureStill(session, page);
}

/* ------------------------------------------------------------------ */
/* Launch / stop                                                      */
/* ------------------------------------------------------------------ */

function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) return "about:blank";
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `https://${value}`;
}

/**
 * `openTab()` and the context-level `page` listener both see new tabs, so a
 * page can be passed in twice. Remember the work per page and share it; this
 * keeps `close` handlers single and avoids duplicate CDP sessions.
 */
const pageAttachments = new WeakMap<Page, Promise<void>>();

function attachPage(session: Session, page: Page, fp: Fingerprint): Promise<void> {
  const cached = pageAttachments.get(page);
  if (cached) return cached;

  page.once("close", () => {
    if (session.activePage === page) {
      session.activePage = session.context.pages()[0] ?? null;
      if (session.activePage) {
        void startView(session, session.activePage);
      } else {
        void stopScreencast(session);
      }
    }
  });

  // `applyPageOverrides` never rejects, but drop the cache on unexpected
  // failures so a later call can retry the override.
  const task = applyPageOverrides(page, fp).catch(() => {
    pageAttachments.delete(page);
  });
  pageAttachments.set(page, task);
  return task;
}

/** Resolve the network Chrome should use, and how we probe geolocation. */
async function prepareNetwork(
  profile: Profile,
  session: Session,
): Promise<{ browserProxy?: string; probeProxy?: ProxyConfig; label: string }> {
  if (profile.vpn?.kind === "wireguard") {
    const port = await startVpn(profile.id, profile.vpn.configPath);
    session.vpnActive = true;
    const proxy: ProxyConfig = {
      type: "socks5",
      host: "127.0.0.1",
      port,
      label: "wireguard",
    };
    return {
      browserProxy: `socks5://127.0.0.1:${port}`,
      probeProxy: proxy,
      label: `WireGuard → 127.0.0.1:${port}`,
    };
  }

  if (profile.proxy) {
    const relay = await startRelay(profile.proxy);
    session.relay = relay;
    return {
      browserProxy: relay.url,
      probeProxy: profile.proxy,
      label: `${profile.proxy.type}://${profile.proxy.host}:${profile.proxy.port}`,
    };
  }

  return { label: "direct" };
}

function geoIsFresh(profile: Profile): boolean {
  if (!profile.geo) return false;
  const age = Date.now() - Date.parse(profile.geo.checkedAt);
  return Number.isFinite(age) && age >= 0 && age < 24 * 60 * 60 * 1000;
}

async function refreshGeoOnLaunch(
  profile: Profile,
  probeProxy: ProxyConfig | undefined,
): Promise<void> {
  // Direct connections can reuse a recent result; proxied ones must re-check
  // because the exit IP may have rotated.
  if (!probeProxy && geoIsFresh(profile)) return;
  try {
    const geo = await lookupGeo(probeProxy, GEO_TIMEOUT_MS);
    profile.geo = geo;
    profile.geoError = undefined;
    profile.fingerprint = applyGeo(profile.fingerprint, geo);
    await saveProfile(profile);
  } catch (err) {
    profile.geoError = (err as Error).message;
    await saveProfile(profile).catch(() => {});
  }
}

export async function launchProfile(profile: Profile): Promise<RuntimeStatus> {
  const existing = sessions.get(profile.id);
  if (existing && (existing.state === "running" || existing.state === "starting")) {
    return describeProfile(profile.id);
  }
  if (existing) sessions.delete(profile.id);

  if (!CHROME_PATH) {
    throw new Error(
      "Chrome/Chromium not found. Install it or set CHROME_PATH to the executable.",
    );
  }

  const session: Session = {
    profileId: profile.id,
    context: null as unknown as BrowserContext,
    vpnActive: false,
    state: "starting",
    startedAt: new Date().toISOString(),
    activePage: null,
    screencast: null,
    frame: null,
    frameAt: 0,
    cleaned: false,
  };
  sessions.set(profile.id, session);

  try {
    const network = await prepareNetwork(profile, session);
    session.proxyServer = network.browserProxy;

    await refreshGeoOnLaunch(profile, network.probeProxy);
    const fp = effectiveFingerprint(profile);

    const context = await chromium.launchPersistentContext(profile.userDataDir, {
      ...contextOptions(fp, network.browserProxy),
    });
    session.context = context;
    context.on("close", () => {
      // Keep the entry when launch failed so the dashboard can show why;
      // a normal running context is removed entirely.
      void disposeSession(session, session.state !== "error");
    });

    await context.addInitScript({ content: fingerprintInitScript(fp) });

    const pages = context.pages();
    const initial = pages[0] ?? (await context.newPage());
    for (const page of pages) await attachPage(session, page, fp);
    if (!pages.includes(initial)) await attachPage(session, initial, fp);
    context.on("page", (page) => {
      void attachPage(session, page, fp);
    });

    session.activePage = initial;
    session.state = "running";

    const startUrl = normalizeUrl(profile.startUrl);
    await initial
      .goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch((err: Error) => {
        session.error = `Unable to open ${startUrl}: ${err.message.split("\n")[0]}`;
      });

    await startView(session, initial);

    profile.lastLaunchedAt = new Date().toISOString();
    await saveProfile(profile).catch(() => {});

    return describeProfile(profile.id);
  } catch (err) {
    session.state = "error";
    session.error = (err as Error).message;
    await disposeSession(session, false);
    throw err;
  }
}

async function disposeSession(session: Session, remove: boolean): Promise<void> {
  if (session.cleaned) {
    if (remove) sessions.delete(session.profileId);
    return;
  }
  session.cleaned = true;
  session.frame = null;

  await stopScreencast(session);
  if (session.context) {
    await session.context.close().catch(() => {});
  }
  if (session.relay) {
    await session.relay.close().catch(() => {});
    session.relay = undefined;
  }
  if (session.vpnActive) {
    await stopVpn(session.profileId).catch(() => {});
    session.vpnActive = false;
  }

  if (remove) sessions.delete(session.profileId);
}

export async function stopProfile(profileId: string): Promise<RuntimeStatus> {
  const session = sessions.get(profileId);
  if (session) await disposeSession(session, true);
  return { profileId, state: "stopped" };
}

/* ------------------------------------------------------------------ */
/* Introspection                                                      */
/* ------------------------------------------------------------------ */

async function tabsOf(session: Session): Promise<TabInfo[]> {
  const pages = session.context.pages();
  const tabs: TabInfo[] = [];
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!;
    let title = "";
    let url = "";
    try {
      title = await page.title();
      url = page.url();
    } catch {
      /* closing */
    }
    tabs.push({ index, title: title || url || "New tab", url, active: page === session.activePage });
  }
  return tabs;
}

export async function describeProfile(profileId: string): Promise<RuntimeStatus> {
  const session = sessions.get(profileId);
  if (!session) return { profileId, state: "stopped" };

  if (session.state === "error") {
    return {
      profileId,
      state: "error",
      startedAt: session.startedAt,
      error: session.error,
      vpnActive: session.vpnActive,
    };
  }

  const tabs = session.context ? await tabsOf(session) : [];
  const active = session.activePage;
  let title: string | undefined;
  let url: string | undefined;
  if (active && !active.isClosed()) {
    url = active.url();
    title = await active.title().catch(() => "");
  }

  return {
    profileId,
    state: session.state,
    startedAt: session.startedAt,
    url,
    title,
    tabs,
    streaming: Boolean(session.screencast),
    proxyServer: session.proxyServer,
    vpnActive: session.vpnActive,
    error: session.error,
  };
}

export function isActive(profileId: string): boolean {
  const session = sessions.get(profileId);
  return Boolean(session && session.state === "running");
}

export function hasSession(profileId: string): boolean {
  return sessions.has(profileId);
}

export async function sessionSnapshot(
  profileId: string,
): Promise<{ thumbnail: Buffer | null; status: RuntimeStatus }> {
  const session = sessions.get(profileId);
  if (!session || session.state !== "running") {
    return { thumbnail: null, status: await describeProfile(profileId) };
  }

  let thumbnail: Buffer | null = null;
  if (session.frame) thumbnail = Buffer.from(session.frame, "base64");
  if (!thumbnail && session.activePage) {
    try {
      thumbnail = await session.activePage.screenshot({ type: "jpeg", quality: 60 });
    } catch {
      /* ignore */
    }
  }
  return { thumbnail, status: await describeProfile(profileId) };
}

/* ------------------------------------------------------------------ */
/* Tab controls                                                       */
/* ------------------------------------------------------------------ */

export async function navigateProfile(profileId: string, url: string): Promise<RuntimeStatus> {
  const session = requireRunning(profileId);
  if (!session.activePage) throw new Error("No active tab");
  await session.activePage.goto(normalizeUrl(url), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await applyPageOverrides(session.activePage, await currentFingerprint(profileId));
  return describeProfile(profileId);
}

async function currentFingerprint(profileId: string): Promise<Fingerprint> {
  const profile = getProfile(profileId);
  if (!profile) throw new Error(`profile ${profileId} not found`);
  return effectiveFingerprint(profile);
}

export async function openTab(profileId: string, url: string): Promise<RuntimeStatus> {
  const session = requireRunning(profileId);
  const page = await session.context.newPage();
  await attachPage(session, page, await currentFingerprint(profileId));
  session.activePage = page;
  await page
    .goto(normalizeUrl(url), { waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => {});
  await page.bringToFront().catch(() => {});
  await startView(session, page);
  return describeProfile(profileId);
}

export async function activateTab(profileId: string, index: number): Promise<RuntimeStatus> {
  const session = requireRunning(profileId);
  const page = session.context.pages()[index];
  if (!page) throw new Error(`tab ${index} not found`);
  session.activePage = page;
  await page.bringToFront().catch(() => {});
  await startView(session, page);
  return describeProfile(profileId);
}

export async function closeTab(profileId: string, index: number): Promise<RuntimeStatus> {
  const session = requireRunning(profileId);
  const page = session.context.pages()[index];
  if (!page) throw new Error(`tab ${index} not found`);
  await page.close().catch(() => {});
  if (session.activePage === page || !session.activePage || session.activePage.isClosed()) {
    session.activePage = session.context.pages()[0] ?? null;
    if (session.activePage) {
      await startView(session, session.activePage);
    }
  }
  return describeProfile(profileId);
}

function requireRunning(profileId: string): Session {
  const session = sessions.get(profileId);
  if (!session || session.state !== "running" || !session.context) {
    throw new Error("Profile is not running");
  }
  return session;
}

/** Used by the health endpoint and the proxy test button. */
export async function probeNetwork(
  proxy: ProxyConfig | undefined,
): Promise<{ ip: string; latencyMs: number }> {
  const started = Date.now();
  const geo = await lookupGeo(proxy, GEO_TIMEOUT_MS);
  return { ip: geo.ip, latencyMs: Date.now() - started };
}

/** Close every browser, relay and VPN process. Called on SIGINT/SIGTERM. */
export async function shutdownAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopProfile(id)));
  await stopAllVpn();
}
