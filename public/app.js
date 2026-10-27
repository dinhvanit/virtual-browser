/* global localStorage, fetch, URLSearchParams, history, location, document, window */

const API_TOKEN_KEY = "vb_token";

/* ------------------------------------------------------------------ */
/* Token bootstrap (optional VB_TOKEN on the server)                   */
/* ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
const urlToken = params.get("token");
if (urlToken) {
  localStorage.setItem(API_TOKEN_KEY, urlToken);
  params.delete("token");
  const qs = params.toString();
  history.replaceState({}, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
}
const TOKEN = localStorage.getItem(API_TOKEN_KEY) || "";

/* ------------------------------------------------------------------ */
/* Tiny DOM / API helpers                                              */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const grid = $("#grid");
const cards = new Map();

const state = {
  profiles: [],
  system: null,
  pending: new Set(),
  search: "",
  filterState: "all",
  filterOs: "all",
  loading: false,
  lastLaunched: new Map(),
};

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function relative(iso) {
  if (!iso) return "";
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff) || diff < 0) return "just now";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function flag(countryCode) {
  if (!countryCode || countryCode.length !== 2) return "🌐";
  const base = 0x1f1e6;
  const chars = [...countryCode.toUpperCase()].map((c) =>
    String.fromCodePoint(base + c.charCodeAt(0) - 65),
  );
  return chars.join("");
}

function osLabel(os) {
  if (os === "windows") return "Windows";
  if (os === "macos") return "macOS";
  return "Native";
}

async function api(path, options = {}) {
  const headers = {};
  if (TOKEN) headers["x-vb-token"] = TOKEN;
  if (options.body !== undefined) {
    headers["content-type"] = options.raw
      ? options.contentType || "application/octet-stream"
      : "application/json";
  }

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body:
      options.body === undefined
        ? undefined
        : options.raw
          ? options.body
          : JSON.stringify(options.body),
  });

  if (response.status === 204) return null;

  const type = response.headers.get("content-type") || "";
  const data = type.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text();

  if (!response.ok) throw new Error(responseError(response, data));
  return data;
}

function responseError(response, data) {
  let message =
    (data && data.error) || (typeof data === "string" && data) || `HTTP ${response.status}`;
  if (response.status === 401) {
    message = TOKEN
      ? "Invalid token or token changed. Reopen the dashboard with /?token=<VB_TOKEN>."
      : "The server requires a token. Open the dashboard with /?token=<VB_TOKEN> (the VB_TOKEN value used at startup).";
  }
  return message;
}

async function download(path, fallbackName) {
  const headers = TOKEN ? { "x-vb-token": TOKEN } : {};
  const response = await fetch(path, { headers });
  if (!response.ok) {
    const type = response.headers.get("content-type") || "";
    const data = type.includes("application/json")
      ? await response.json().catch(() => null)
      : await response.text();
    throw new Error(responseError(response, data));
  }

  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const name = match?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function toast(message, kind = "info", timeout = 5000) {
  const container = $("#toasts");
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.textContent = message;
  container.append(node);
  const remove = () => {
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 180);
  };
  const timer = setTimeout(remove, timeout);
  node.addEventListener("click", () => {
    clearTimeout(timer);
    remove();
  });
}

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

let refreshPromise = null;

async function refresh({ silent = false } = {}) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    state.loading = true;
    try {
      const data = await api("/api/profiles");
      state.profiles = data.profiles || [];
      render();
    } catch (err) {
      if (!silent) toast(err.message, "error");
    } finally {
      state.loading = false;
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function loadSystem() {
  try {
    const system = await api("/api/system");
    state.system = system;
    renderSystem();
  } catch (err) {
    console.warn("system info unavailable", err);
  }
}

/* ------------------------------------------------------------------ */
/* Card rendering                                                      */
/* ------------------------------------------------------------------ */

function signature(profile) {
  return JSON.stringify({
    id: profile.id,
    name: profile.name,
    notes: profile.notes,
    tags: profile.tags,
    startUrl: profile.startUrl,
    proxy: profile.proxy,
    vpn: profile.vpn,
    fingerprint: profile.fingerprint,
    geo: profile.geo,
    geoError: profile.geoError,
    lastCheck: profile.lastCheck,
    lastLaunchedAt: profile.lastLaunchedAt,
    updatedAt: profile.updatedAt,
  });
}

function buildCard(profile) {
  const fp = profile.fingerprint || {};
  const os = fp.osProfile || "native";
  const tags = (profile.tags || [])
    .map((tag) => `<span class="tag">${esc(tag)}</span>`)
    .join("");

  let geo;
  if (profile.geo) {
    const place = [profile.geo.city, profile.geo.country].filter(Boolean).join(", ");
    geo = `<span class="flag">${flag(profile.geo.countryCode)}</span>
      <span>${esc(place || profile.geo.region || "Unknown")}</span>
      <span class="ip" title="${esc(profile.geo.isp || "")}">${esc(profile.geo.ip)}</span>`;
  } else if (profile.geoError) {
    geo = `<span class="geo-error" title="${esc(profile.geoError)}">IP check failed — see Check</span>`;
  } else {
    geo = `<span>IP not checked yet</span>`;
  }

  const screen = `${fp.screen?.width ?? "?"}×${fp.screen?.height ?? "?"} @${fp.deviceScaleFactor ?? "?"}x`;
  const hardware = `${fp.hardwareConcurrency ?? "?"}C / ${fp.deviceMemory ?? "?"}GB`;

  const network = profile.vpn
    ? `<span class="chip vpn">⛓ WireGuard <b>${esc(profile.vpn.configPath.split("/").pop())}</b></span>`
    : profile.proxy
      ? `<span class="chip proxy">⇄ <b>${esc(profile.proxy.type.toUpperCase())}</b> ${esc(profile.proxy.host)}:${profile.proxy.port}${profile.proxy.label ? ` · ${esc(profile.proxy.label)}` : ""}</span>`
      : `<span class="chip direct">Direct connection</span>`;

  const lastLaunched = profile.lastLaunchedAt
    ? `<span class="last-launch">launched ${relative(profile.lastLaunchedAt)}</span>`
    : "";

  const card = document.createElement("article");
  card.className = "card";
  card.dataset.id = profile.id;
  card.dataset.state = profile.runtime?.state || "stopped";
  card._sig = signature(profile);
  card.innerHTML = `
    <div class="thumb">
      <img data-role="thumb" alt="" />
      <div class="thumb-placeholder">
        <span class="glyph">◐</span>
        <span class="os-label">${esc(osLabel(os))}</span>
        <span class="hint">Launch to see a live view</span>
      </div>
      <span class="state-badge" data-role="state">Stopped</span>
      <span class="os-chip">${esc(os)}</span>
    </div>

    <div class="card-body">
      <div class="title-row">
        <h3 title="${esc(profile.name)}">${esc(profile.name)}</h3>
        ${lastLaunched}
      </div>

      ${tags ? `<div class="tags">${tags}</div>` : ""}
      <div class="geo">${geo}</div>

      <div class="facts">
        <div class="fact"><span>Locale</span><strong>${esc(fp.locale ?? "?")}</strong></div>
        <div class="fact"><span>Timezone</span><strong title="${esc(fp.timezone ?? "")}">${esc(fp.timezone ?? "?")}</strong></div>
        <div class="fact"><span>Screen</span><strong>${esc(screen)}</strong></div>
        <div class="fact"><span>CPU / RAM</span><strong>${esc(hardware)}</strong></div>
        <div class="fact"><span>Chrome</span><strong>${esc(fp.chromeVersion ?? "?")}</strong></div>
        <div class="fact"><span>Platform</span><strong>${esc(fp.platform ?? "?")}</strong></div>
      </div>

      <div class="chips">${network}</div>
      <div class="card-error hidden" data-role="error"></div>
      <div class="runtime-panel hidden" data-role="runtime"></div>

      <div class="actions">
        <button type="button" class="btn primary" data-action="launch" data-role="launch">▶ Launch</button>
        <button type="button" class="btn ghost" data-action="check" title="Check exit IP and geolocation">Check IP</button>
        <button type="button" class="btn ghost" data-action="edit">Edit</button>
        <span class="spacer"></span>
        <button type="button" class="btn icon ghost" data-action="menu" title="More actions">⋯</button>
        <div class="menu hidden">
          <button type="button" data-action="duplicate">Duplicate profile</button>
          <button type="button" data-action="regen">Regenerate fingerprint</button>
          <button type="button" data-action="delete" class="danger">Delete profile</button>
        </div>
      </div>
    </div>
  `;
  card.querySelector('[data-action="menu"]').addEventListener("click", (event) => {
    event.stopPropagation();
    closeMenus(card);
    card.querySelector(".menu").classList.toggle("hidden");
  });
  return card;
}

function updateRuntime(card, profile) {
  const runtime = profile.runtime || { state: "stopped" };
  const stateName = runtime.state || "stopped";
  const pending = state.pending.has(profile.id);

  card.dataset.state = stateName;
  const badge = card.querySelector('[data-role="state"]');
  badge.textContent =
    stateName === "running"
      ? "Running"
      : stateName === "starting"
        ? "Starting"
        : stateName === "error"
          ? "Error"
          : "Stopped";

  const launch = card.querySelector('[data-role="launch"]');
  const isUp = stateName === "running" || stateName === "starting";

  if (pending) {
    launch.disabled = true;
    launch.innerHTML = `<span class="spinner"></span>${isUp ? "Stopping…" : "Starting…"}`;
  } else if (stateName === "starting") {
    launch.disabled = true;
    launch.innerHTML = `<span class="spinner"></span>Starting…`;
  } else {
    launch.disabled = false;
    launch.dataset.action = isUp ? "stop" : "launch";
    launch.textContent = isUp ? "■ Stop" : "▶ Launch";
  }

  for (const button of card.querySelectorAll(".actions > .btn, .actions .menu button")) {
    if (button !== launch) button.disabled = pending;
  }

  const errorBox = card.querySelector('[data-role="error"]');
  if (runtime.error) {
    errorBox.textContent = runtime.error;
    errorBox.classList.remove("hidden");
  } else {
    errorBox.textContent = "";
    errorBox.classList.add("hidden");
  }

  const panel = card.querySelector('[data-role="runtime"]');
  if (stateName !== "running") {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  if (panel.contains(document.activeElement)) return;

  const activeUrl = runtime.url || "";
  const tabs = runtime.tabs || [];
  const panelSig = JSON.stringify({ tabs, activeUrl, proxy: runtime.proxyServer, vpn: runtime.vpnActive });
  if (panel._sig === panelSig) return;
  panel._sig = panelSig;

  const tabItems = tabs
    .map(
      (tab) => `<button type="button" class="tab ${tab.active ? "active" : ""}" data-action="activate-tab" data-index="${tab.index}" title="${esc(tab.url || tab.title)}">
        <span class="tab-title">${esc(tab.title || tab.url || "New tab")}</span>
        <span class="tab-x" data-action="close-tab" data-index="${tab.index}" title="Close tab">×</span>
      </button>`,
    )
    .join("");

  panel.innerHTML = `
    <div class="tabs">
      ${tabItems}
      <button type="button" class="tab-new" data-action="new-tab" title="New tab">+</button>
    </div>
    <div class="nav-row">
      <input data-role="url" value="${esc(activeUrl)}" placeholder="https://…" spellcheck="false" />
      <button type="button" class="btn" data-action="go">Go</button>
    </div>
    <div class="runtime-meta">
      ${
        runtime.proxyServer
          ? `<span class="chip proxy">via <b>${esc(runtime.proxyServer)}</b></span>`
          : `<span class="chip direct">direct</span>`
      }
      ${runtime.vpnActive ? `<span class="chip vpn">WireGuard active</span>` : ""}
    </div>
  `;
}

function matchesFilters(profile) {
  const runtime = profile.runtime || {};
  const runtimeState = runtime.state || "stopped";

  if (state.filterState === "running" && !["running", "starting"].includes(runtimeState)) {
    return false;
  }
  if (state.filterState === "stopped" && !["stopped", "error"].includes(runtimeState)) {
    return false;
  }
  if (state.filterOs !== "all" && (profile.fingerprint?.osProfile || "native") !== state.filterOs) {
    return false;
  }

  const haystack = [
    profile.name,
    profile.notes,
    ...(profile.tags || []),
    profile.geo?.ip,
    profile.geo?.country,
    profile.geo?.city,
    profile.geo?.isp,
    profile.proxy?.host,
    profile.proxy?.label,
    profile.startUrl,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return !state.search || haystack.includes(state.search);
}

function render() {
  const ids = new Set(state.profiles.map((profile) => profile.id));
  for (const [id, card] of cards) {
    if (!ids.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }

  let previous = null;
  for (const profile of state.profiles) {
    let card = cards.get(profile.id);
    const sig = signature(profile);
    if (!card || card._sig !== sig) {
      const fresh = buildCard(profile);
      if (card) {
        card.replaceWith(fresh);
      } else if (previous) {
        previous.after(fresh);
      } else {
        grid.prepend(fresh);
      }
      cards.set(profile.id, fresh);
      card = fresh;
    } else if (previous && previous.nextSibling !== card) {
      previous.after(card);
    }

    updateRuntime(card, profile);
    card.classList.toggle("hidden", !matchesFilters(profile));
    previous = card;
  }

  updateChrome();
}

function updateChrome() {
  const total = state.profiles.length;
  const running = state.profiles.filter((p) => p.runtime?.state === "running").length;
  $("#stat-total").textContent = String(total);
  $("#stat-running").textContent = String(running);
  $("#stat-dot").className = `dot ${running ? "" : "off"}`;

  const visibleCount = [...cards.values()].filter((c) => !c.classList.contains("hidden")).length;
  $("#visible-count").textContent =
    total === 0 ? "" : `${visibleCount} of ${total} shown`;

  $("#empty").classList.toggle("hidden", total !== 0);
}

/* ------------------------------------------------------------------ */
/* System header / footer                                              */
/* ------------------------------------------------------------------ */

function renderSystem() {
  const system = state.system;
  if (!system) return;

  const chrome = system.chrome || {};
  const wireproxy = system.wireproxy || {};

  const chromeChip = $("#chip-chrome");
  chromeChip.innerHTML = `<span class="dot ${chrome.found ? "" : "warn"}"></span> Chrome ${
    chrome.found ? esc(chrome.version) : "not found"
  }`;

  const wireChip = $("#chip-wireproxy");
  wireChip.innerHTML = `<span class="dot ${wireproxy.found ? "" : "off"}"></span> wireproxy ${
    wireproxy.found ? "ready" : "missing"
  }`;

  $("#chip-headless").classList.toggle("hidden", !system.headless);
  $("#foot-version").textContent = `v${system.version}`;
  $("#foot-data").textContent = system.dataDir;
  $("#foot-platform").textContent = `${system.platform} · node ${system.node}`;
  $("#foot-headless").textContent = system.headless ? "headless mode" : "headed mode";

  if (TOKEN) {
    $("#foot-token").classList.remove("hidden");
    $("#foot-token").textContent = "API token active";
  }

  const banner = $("#banner");
  if (!chrome.found) {
    banner.classList.remove("hidden");
    banner.innerHTML =
      "<strong>Chrome/Chromium not found.</strong> Install Google Chrome or set <code>CHROME_PATH</code>, then restart the server.";
    return;
  }

  const needsVpn = state.profiles.some((p) => p.vpn);
  if (needsVpn && !wireproxy.found) {
    banner.classList.remove("hidden");
    banner.innerHTML =
      "<strong>wireproxy not found.</strong> Profiles using WireGuard cannot launch. Install wireproxy or set <code>VB_WIREPROXY</code>.";
    return;
  }

  banner.classList.add("hidden");
  banner.innerHTML = "";
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function profileById(id) {
  return state.profiles.find((p) => p.id === id);
}

function closeMenus(except = null) {
  for (const card of cards.values()) {
    if (card === except) continue;
    card.querySelector(".menu")?.classList.add("hidden");
  }
}

async function runProfileAction(id, fn) {
  if (state.pending.has(id)) return;
  const profile = profileById(id);
  if (!profile) return;

  state.pending.add(id);
  updateRuntime(cards.get(id), profile);
  try {
    await fn(profile);
  } catch (err) {
    toast(err.message || String(err), "error", 8000);
  } finally {
    state.pending.delete(id);
    const current = profileById(id);
    if (current) updateRuntime(cards.get(id), current);
    await refresh({ silent: true });
  }
}

async function handleGridClick(event) {
  const actionEl = event.target.closest("[data-action]");
  if (!actionEl) {
    closeMenus();
    return;
  }
  const card = actionEl.closest(".card");
  if (!card) return;
  const id = card.dataset.id;
  const profile = profileById(id);
  if (!profile) return;
  const action = actionEl.dataset.action;

  if (action !== "menu") closeMenus();

  switch (action) {
    case "launch":
      return runProfileAction(id, async () => {
        await api(`/api/profiles/${id}/launch`, { method: "POST" });
        const geo = profileById(id)?.geo;
        toast(
          geo ? `Launched · exit ${geo.ip} (${geo.countryCode || "?"})` : "Browser launched",
          "ok",
        );
      });

    case "stop":
      return runProfileAction(id, async () => {
        await api(`/api/profiles/${id}/stop`, { method: "POST" });
        toast("Browser stopped", "ok");
      });

    case "check":
      return runProfileAction(id, async () => {
        toast("Checking exit IP…", "info", 2500);
        const data = await api(`/api/profiles/${id}/check`, { method: "POST" });
        const check = data.check;
        if (check.ok) {
          const geo = check.geo;
          toast(
            `Exit IP ${geo.ip} · ${[geo.city, geo.country].filter(Boolean).join(", ")} · ${check.latencyMs}ms`,
            "ok",
            7000,
          );
        } else {
          throw new Error(check.error || "Network check failed");
        }
      });

    case "edit":
      openEdit(profile);
      return;

    case "duplicate":
      return runProfileAction(id, async () => {
        const data = await api(`/api/profiles/${id}/duplicate`, { method: "POST" });
        toast(`Duplicated as "${data.profile.name}"`, "ok");
      });

    case "regen":
      return runProfileAction(id, async () => {
        await api(`/api/profiles/${id}/fingerprint`, {
          method: "POST",
          body: {
            osProfile: profile.fingerprint?.osProfile,
            locale: null,
            timezone: null,
          },
        });
        toast("Fingerprint regenerated (applies on next launch)", "ok");
      });

    case "delete":
      return confirmDelete(profile);

    case "activate-tab":
      return runProfileAction(id, async () => {
        await api(`/api/profiles/${id}/tabs/${actionEl.dataset.index}/activate`, {
          method: "POST",
        });
      });

    case "close-tab":
      return runProfileAction(id, async () => {
        await api(`/api/profiles/${id}/tabs/${actionEl.dataset.index}`, {
          method: "DELETE",
        });
      });

    case "new-tab":
      return runProfileAction(id, async () => {
        await api(`/api/profiles/${id}/tabs`, {
          method: "POST",
          body: { url: "about:blank" },
        });
      });

    case "go": {
      const input = card.querySelector('[data-role="url"]');
      const url = input?.value?.trim();
      if (!url) return;
      return runProfileAction(id, async () => {
        await api(`/api/profiles/${id}/navigate`, { method: "POST", body: { url } });
      });
    }

    default:
      return;
  }
}

async function confirmDelete(profile) {
  const ok = await confirmDialog({
    title: `Delete "${profile.name}"?`,
    message:
      "The Chrome user-data directory (cookies, sessions, local storage) and the profile entry will be removed permanently.",
    confirmLabel: "Delete profile",
  });
  if (!ok) return;

  try {
    await api(`/api/profiles/${profile.id}`, { method: "DELETE" });
    toast("Profile deleted", "ok");
    await refresh();
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ------------------------------------------------------------------ */
/* Data: export / import / backup / restore                            */
/* ------------------------------------------------------------------ */

function closeDataMenu() {
  $("#data-menu").classList.add("hidden");
  $("#data-btn").setAttribute("aria-expanded", "false");
}

function openFilePicker(input) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      input.removeEventListener("change", onChange);
      window.removeEventListener("focus", onFocus);
      resolve(file);
    };
    const onChange = () => finish(input.files?.[0] || null);
    const onFocus = () => {
      // There is no standard "file dialog cancelled" event. When focus returns
      // without a selection, treat it as a cancel instead of leaving the promise
      // pending forever.
      setTimeout(() => {
        if (!input.files?.length) finish(null);
      }, 400);
    };

    input.value = "";
    input.addEventListener("change", onChange);
    window.addEventListener("focus", onFocus);
    input.click();
  });
}

function importSummary(data) {
  let message = `Imported ${data.imported} profile${data.imported === 1 ? "" : "s"}.`;
  if (data.skipped?.length) {
    const details = data.skipped
      .slice(0, 3)
      .map((item) => `${item.name} (${item.reason})`)
      .join("; ");
    message += ` Skipped ${data.skipped.length}: ${details}`;
    if (data.skipped.length > 3) message += "; …";
  }
  return message;
}

function reportImportWarnings(data) {
  if (!data.warnings?.length) return;
  for (const warning of data.warnings) {
    console.warn(`[import] ${warning.profile}: ${warning.message}`);
  }
  toast(
    `${data.warnings.length} import warning${data.warnings.length === 1 ? "" : "s"}; see the browser console.`,
    "info",
    8000,
  );
}

async function exportProfiles() {
  try {
    const date = new Date().toISOString().slice(0, 10);
    await download("/api/export", `virtual-browser-${date}.json`);
    toast("Profile export downloaded (contains proxy credentials).", "ok", 7000);
  } catch (err) {
    toast(err.message, "error", 9000);
  }
}

async function backupAll() {
  const active = state.profiles.filter((profile) =>
    ["running", "starting"].includes(profile.runtime?.state),
  );
  if (active.length) {
    toast(
      `Stop ${active.length} running profile${active.length === 1 ? "" : "s"} before backing up.`,
      "error",
      8000,
    );
    return;
  }

  const ok = await confirmDialog({
    title: "Download a full backup?",
    message:
      "The archive contains Chrome cookies, logins, local storage, proxy credentials and VPN paths. Store it somewhere encrypted. Backups are only consistent when profiles are stopped.",
    confirmLabel: "Download backup",
  });
  if (!ok) return;

  try {
    const date = new Date().toISOString().slice(0, 10);
    await download("/api/backup", `virtual-browser-backup-${date}.tar.gz`);
    toast("Full backup downloaded. Treat it as a secret.", "ok", 8000);
  } catch (err) {
    toast(err.message, "error", 9000);
  }
}

async function importProfiles() {
  const file = await openFilePicker($("#import-file"));
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    toast("That file is not valid JSON.", "error", 8000);
    return;
  }

  try {
    const data = await api("/api/import", { method: "POST", body: payload });
    toast(importSummary(data), data.imported ? "ok" : "error", 12_000);
    reportImportWarnings(data);
    await refresh();
  } catch (err) {
    toast(err.message, "error", 10_000);
  }
}

async function restoreBackup() {
  const file = await openFilePicker($("#restore-file"));
  if (!file) return;

  const ok = await confirmDialog({
    title: "Restore a backup?",
    message:
      "Profiles and browser data are added as new profiles; existing profiles are not overwritten. A backup from another machine may contain VPN paths that need fixing before launch.",
    confirmLabel: "Restore backup",
  });
  if (!ok) return;

  toast("Restoring backup — this can take a while for large profiles…", "info", 20_000);
  try {
    const data = await api("/api/restore", {
      method: "POST",
      body: file,
      raw: true,
      contentType: "application/gzip",
    });
    toast(importSummary(data), data.imported ? "ok" : "error", 12_000);
    reportImportWarnings(data);
    await refresh();
  } catch (err) {
    toast(err.message, "error", 12_000);
  }
}

/* ------------------------------------------------------------------ */
/* Confirm dialog                                                      */
/* ------------------------------------------------------------------ */

let confirmResolver = null;

function confirmDialog({ title, message, confirmLabel = "Delete" }) {
  $("#confirm-title").textContent = title;
  $("#confirm-message").textContent = message;
  $("#confirm-ok").textContent = confirmLabel;
  $("#confirm-modal").classList.remove("hidden");
  return new Promise((resolve) => {
    confirmResolver = resolve;
  });
}

function closeConfirm(result) {
  $("#confirm-modal").classList.add("hidden");
  if (confirmResolver) {
    confirmResolver(result);
    confirmResolver = null;
  }
}

/* ------------------------------------------------------------------ */
/* Create / edit modal                                                 */
/* ------------------------------------------------------------------ */

const form = $("#profile-form");
let editing = null;

function field(name) {
  return form.elements.namedItem(name);
}

function setProxyEnabled(enabled) {
  $("#proxy-enabled").checked = enabled;
  for (const input of $("#proxy-fields").querySelectorAll("input, select")) {
    input.disabled = !enabled;
  }
}

function setVpnEnabled(enabled) {
  $("#vpn-enabled").checked = enabled;
  for (const input of $("#vpn-fields").querySelectorAll("input")) {
    input.disabled = !enabled;
  }
}

function fillForm(profile) {
  form.reset();
  field("name").value = profile?.name ?? "";
  field("tags").value = (profile?.tags || []).join(", ");
  field("startUrl").value = profile?.startUrl ?? state.system?.defaultStartUrl ?? "https://example.com/";
  field("osProfile").value = profile?.fingerprint?.osProfile ?? "native";
  const fp = profile?.fingerprint;
  field("locale").value = fp?.localePinned ? fp.locale : "";
  field("locale").placeholder = fp ? `auto — currently ${fp.locale}` : "auto — e.g. en-US";
  field("timezone").value = fp?.timezonePinned ? fp.timezone : "";
  field("timezone").placeholder = fp
    ? `auto — currently ${fp.timezone}`
    : "auto — America/New_York";
  field("notes").value = profile?.notes ?? "";

  const proxy = profile?.proxy;
  setProxyEnabled(Boolean(proxy));
  field("proxyType").value = proxy?.type ?? "http";
  field("proxyHost").value = proxy?.host ?? "";
  field("proxyPort").value = proxy?.port ?? "";
  field("proxyUser").value = proxy?.username ?? "";
  field("proxyPass").value = proxy?.password ?? "";
  field("proxyLabel").value = proxy?.label ?? "";

  const vpn = profile?.vpn;
  setVpnEnabled(Boolean(vpn));
  field("vpnPath").value = vpn?.configPath ?? "";

  $("#test-result").textContent = "";
  $("#test-result").className = "test-result";
  $("#save-hint").textContent = "";
}

function openCreate() {
  editing = null;
  fillForm(null);
  $("#modal-title").textContent = "New profile";
  $("#modal-subtitle").textContent =
    "Each profile gets an isolated Chrome profile and a fingerprint derived from the exit IP.";
  $("#save-profile-btn").textContent = "Create profile";
  openModal();
}

function openEdit(profile) {
  editing = profile;
  fillForm(profile);
  $("#modal-title").textContent = `Edit "${profile.name}"`;
  $("#modal-subtitle").textContent =
    "Network changes apply on the next launch. Fingerprint changes apply on the next launch too.";
  $("#save-profile-btn").textContent = "Save changes";
  openModal();
}

function openModal() {
  closeMenus();
  const modal = $("#profile-modal");
  modal.classList.remove("hidden");
  setTimeout(() => field("name").focus(), 30);
}

function closeModal() {
  $("#profile-modal").classList.add("hidden");
  editing = null;
}

function collectProxy() {
  if (!$("#proxy-enabled").checked) return null;
  const type = field("proxyType").value;
  const host = field("proxyHost").value.trim();
  const port = Number(field("proxyPort").value);
  if (!host) throw new Error("Proxy host is required (or disable the proxy section).");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Proxy port must be between 1 and 65535.");
  }
  const proxy = { type, host, port };
  const username = field("proxyUser").value.trim();
  const password = field("proxyPass").value;
  const label = field("proxyLabel").value.trim();
  if (username) proxy.username = username;
  if (password) proxy.password = password;
  if (label) proxy.label = label;
  return proxy;
}

function collectVpn() {
  if (!$("#vpn-enabled").checked) return null;
  const configPath = field("vpnPath").value.trim();
  if (!configPath) throw new Error("WireGuard config path is required (or disable the VPN section).");
  return { kind: "wireguard", configPath };
}

function collectForm() {
  const name = field("name").value.trim();
  if (!name) throw new Error("Name is required.");

  const tags = field("tags")
    .value.split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

  const startUrl = field("startUrl").value.trim() || "https://example.com/";
  const locale = field("locale").value.trim();
  const timezone = field("timezone").value.trim();

  const body = {
    name,
    tags,
    startUrl,
    osProfile: field("osProfile").value,
    notes: field("notes").value.trim() || null,
    proxy: collectProxy(),
    vpn: collectVpn(),
  };

  // Only send locale/timezone when the user actually pinned or cleared them,
  // otherwise an unrelated edit would silently pin the geo-derived value.
  if (locale) body.locale = locale;
  else if (editing?.fingerprint?.localePinned) body.locale = null;

  if (timezone) body.timezone = timezone;
  else if (editing?.fingerprint?.timezonePinned) body.timezone = null;

  return body;
}

async function submitForm(event) {
  event.preventDefault();
  const button = $("#save-profile-btn");
  const hint = $("#save-hint");
  hint.textContent = "";
  hint.className = "test-result";

  let body;
  try {
    body = collectForm();
  } catch (err) {
    hint.textContent = err.message;
    hint.classList.add("bad");
    return;
  }

  button.disabled = true;
  const previousLabel = button.textContent;
  button.textContent = "Saving…";

  try {
    if (editing) {
      await api(`/api/profiles/${editing.id}`, { method: "PATCH", body });
      toast("Profile updated", "ok");
    } else {
      await api("/api/profiles", { method: "POST", body });
      toast("Profile created", "ok");
    }
    closeModal();
    await refresh();
  } catch (err) {
    hint.textContent = err.message;
    hint.classList.add("bad");
    toast(err.message, "error", 8000);
  } finally {
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

async function testProxy() {
  const button = $("#test-proxy-btn");
  const result = $("#test-result");
  result.className = "test-result";
  result.textContent = "Checking…";
  button.disabled = true;

  try {
    const proxy = collectProxy();
    const data = await api("/api/proxy/check", { method: "POST", body: { proxy } });
    const check = data.check;
    if (check.ok) {
      const geo = check.geo;
      result.classList.add("ok");
      result.textContent = `OK · ${geo.ip} · ${[geo.city, geo.country].filter(Boolean).join(", ")} · ${check.latencyMs}ms`;
    } else {
      result.classList.add("bad");
      result.textContent = check.error || "Proxy check failed";
    }
  } catch (err) {
    result.classList.add("bad");
    result.textContent = err.message;
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* Thumbnail polling                                                   */
/* ------------------------------------------------------------------ */

function tickThumbnails() {
  if (document.hidden) return;
  for (const profile of state.profiles) {
    if (profile.runtime?.state !== "running") continue;
    const card = cards.get(profile.id);
    if (!card) continue;
    const img = card.querySelector('[data-role="thumb"]');
    if (!img || img.dataset.loading === "1") continue;

    img.dataset.loading = "1";
    const probe = new Image();
    probe.onload = () => {
      img.src = probe.src;
      img.dataset.loading = "0";
      card.querySelector(".thumb")?.classList.add("has-shot");
    };
    probe.onerror = () => {
      img.dataset.loading = "0";
    };
    probe.src = `/api/profiles/${profile.id}/thumbnail?ts=${Date.now()}`;
  }
}

/* ------------------------------------------------------------------ */
/* Event wiring                                                        */
/* ------------------------------------------------------------------ */

function wireEvents() {
  grid.addEventListener("click", handleGridClick);

  grid.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = event.target.closest('[data-role="url"]');
    if (!input) return;
    event.preventDefault();
    const card = input.closest(".card");
    card.querySelector('[data-action="go"]')?.click();
  });

  $("#search").addEventListener("input", (event) => {
    state.search = event.target.value.trim().toLowerCase();
    render();
  });

  $("#filter-state").addEventListener("change", (event) => {
    state.filterState = event.target.value;
    render();
  });

  $("#filter-os").addEventListener("change", (event) => {
    state.filterOs = event.target.value;
    render();
  });

  $("#refresh-btn").addEventListener("click", () => refresh());
  $("#new-profile-btn").addEventListener("click", openCreate);
  $("#empty-create").addEventListener("click", openCreate);

  $("#data-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#data-menu");
    const willOpen = menu.classList.contains("hidden");
    closeMenus();
    closeDataMenu();
    if (willOpen) {
      menu.classList.remove("hidden");
      $("#data-btn").setAttribute("aria-expanded", "true");
    }
  });
  $("#export-json").addEventListener("click", () => {
    closeDataMenu();
    void exportProfiles();
  });
  $("#import-json").addEventListener("click", () => {
    closeDataMenu();
    void importProfiles();
  });
  $("#backup-all").addEventListener("click", () => {
    closeDataMenu();
    void backupAll();
  });
  $("#restore-backup").addEventListener("click", () => {
    closeDataMenu();
    void restoreBackup();
  });

  form.addEventListener("submit", submitForm);
  $("#test-proxy-btn").addEventListener("click", testProxy);
  $("#proxy-enabled").addEventListener("change", (event) => setProxyEnabled(event.target.checked));
  $("#vpn-enabled").addEventListener("change", (event) => setVpnEnabled(event.target.checked));

  for (const el of document.querySelectorAll("[data-close-modal]")) {
    el.addEventListener("click", closeModal);
  }

  $("#confirm-cancel").addEventListener("click", () => closeConfirm(false));
  $("#confirm-ok").addEventListener("click", () => closeConfirm(true));

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu") && !event.target.closest('[data-action="menu"]')) {
      closeMenus();
    }
    if (!event.target.closest(".data-wrap")) closeDataMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (!$("#confirm-modal").classList.contains("hidden")) {
        closeConfirm(false);
        return;
      }
      if (!$("#profile-modal").classList.contains("hidden")) {
        closeModal();
        return;
      }
      closeMenus();
      closeDataMenu();
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#search").focus();
    }
  });

  window.addEventListener("beforeunload", () => {
    // Browsers stay alive on the server on purpose; nothing to clean here.
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  wireEvents();
  await Promise.all([loadSystem(), refresh()]);
  renderSystem();
  setInterval(() => {
    if (!document.hidden) refresh({ silent: true });
  }, 3000);
  setInterval(tickThumbnails, 1800);
  setTimeout(tickThumbnails, 500);
}

boot();
