# Devlog

Records **actual work**: what was done, why, how it was verified, what is still open. Each
entry is organized by date; new entries go at the top. Not a replacement for the CHANGELOG
(which is for users).

---

## 2026-10-28 — v0.3.0 data safety (import, backup, restore)

### Context

The top roadmap item was "never lose user data". v0.2.0 could export JSON metadata but
had no import, no browser-data backup, and no restore path. This increment adds a complete,
additive data flow without exposing the data directory to path traversal or lying about
what a backup contains.

### What was done

- Added `src/lib/import.ts`:
  - accepts `virtual-browser/export`, a `profiles.json` store, or a bare array;
  - assigns a new id + `userDataDir` to every imported profile;
  - preserves fingerprint/seed, proxy, VPN path, tags, notes, start URL and sanitized geo;
  - per-profile validation: one bad profile is skipped, the batch continues;
  - VPN paths are kept even when missing locally (launch fails loudly instead of silently
    going direct), with an import warning.
- Added `src/lib/backup.ts`:
  - `GET /api/backup` streams `profiles.json` + `profiles/<id>/user-data` as `.tar.gz`;
  - excludes Chrome `Singleton*` lock files and non-regular files (symlinks/devices);
  - preserves safe hardlinks (restore accepts them only when their target is a safe file
    that appeared earlier);
  - refuses backups while any profile session exists;
  - restore inspects entries before extraction; rejects `..`, absolute paths, backslashes,
    symlinks, unsafe hardlink targets, devices, unknown roots, >200k entries and oversized
    archives.
- Added `src/server/routes/data.ts`:
  - `POST /api/import` (JSON, 16 MiB default);
  - `GET /api/backup` (gzip stream);
  - `POST /api/restore` (raw `application/gzip` streamed to a temp file).
  - Restores are additive and use one atomic store write.
- Added a serialized store mutation queue so concurrent imports/edits cannot interleave
  in-memory changes or rename stale snapshots over each other; `initStore` writes an empty
  `profiles.json` on a fresh data directory so a zero-profile backup is valid.
- Hardened profile deletion: it removes only `profiles/<valid-id>/`, never the profiles root,
  even if a hand-edited store points `userDataDir` at a parent directory.
- Added dashboard **Data** menu: export/import JSON, backup, restore, with confirmations.
- Upgraded `@fastify/static` 8 → 10.1.8 after `npm audit` reported a high-severity
  path-traversal/guard-bypass advisory in the old range; set `dotfiles: "deny"`.
- Added `scripts/verify-data.ts` and `scripts/verify-ui-data.ts`.

### Bugs found and fixed during verification

1. **Throwing from `tar`'s `onentry` crashed the whole server.**
   A malicious archive (`../evil.txt`) raised `HttpError` inside the parser event loop; it
   was an `uncaughtException`, not a rejected request. `inspectBackup()` now records the
   first failure and throws only after listing finishes. `verify:data` builds a real
   traversal archive with `tar.c({ prefix: "../" })` and asserts HTTP 400 + no file escape.
2. **Import body check rejected valid JSON.** Fastify parses `application/json` into an
   object, not a Buffer/string. Removed the Buffer check and pass `req.body` to
   `parseImportPayload`.
3. **`@fastify/static` v10 changed `setHeaders(res, ...)` to `(reply, ...)`.** Updated the
   HTML `Cache-Control` hook and added `dotfiles: "deny"`.
4. **File-picker cancel left a pending promise.** Added a focus-return fallback that
   resolves `null` when the dialog closes without a selection.

### Verification

```text
$ npm run typecheck
typecheck OK

$ npm run verify:data -- http://127.0.0.1:8799
  ok  archive path validation
  ok  traversal archive is rejected
  ok  create profile + browser data marker
  ok  JSON export
  ok  JSON import (new id, preserved fingerprint/proxy)
  ok  full backup (~1 KB)
  ok  full restore (browser data copied, ids remapped, links handled)
  ok  invalid profile is skipped without aborting the import
OK: data import/export/backup/restore verified.

$ npm run verify:ui-data -- http://127.0.0.1:8799
  ok  data menu opens
  ok  export JSON download
  ok  import JSON via dashboard
  ok  backup download via dashboard
  ok  restore archive via dashboard
OK: dashboard data flows verified.

$ # concurrent addProfiles test
{ inMemory: 40, onDisk: 40 }

$ npm audit --omit=dev
found 0 vulnerabilities
```

### Notes / next

- Backup archives are unencrypted by design for v0.3.0; the UI states this. Encryption is
  a candidate for v0.6.
- Restore is additive; a future "replace all" mode needs an explicit two-step confirmation
  and a pre-restore automatic backup.
- Next roadmap items: groups/sorting, bulk actions, pinned fingerprint badges/presets.

---

## 2026-10-28 — English localization for international distribution

### Context

The project is being positioned for an international audience (QA, automation, and
self-hosted privacy users). All user-facing documentation and UI strings were Vietnamese;
the code, API, and identifiers were already English. This entry covers the localization
pass only — no runtime behavior changed.

### What was done

- Rewrote `README.md` in English with a marketing-oriented structure: positioning, target
  users, feature table, comparison with cloud browser services, quick start, workflow,
  configuration, data/security, architecture, API, verification, limitations, acceptable
  use, contributing, license.
- Translated every document under `docs/` to English:
  `API.md`, `ARCHITECTURE.md`, `CHANGELOG.md`, `DEVLOG.md`, `FINGERPRINT.md`, `NETWORK.md`,
  `PROCESS.md`, `ROADMAP.md`, `SECURITY.md`, `TROUBLESHOOTING.md`.
- Translated the two remaining Vietnamese UI strings in `public/app.js` (missing/invalid
  token toasts) and updated `scripts/verify-token-ui.ts` to assert the English message.
- Added a root `SECURITY.md` with supported versions, private vulnerability reporting,
  scope, response expectations, deployment checklist, and safe harbor. Linked it from
  `docs/SECURITY.md`.
- Kept `LICENSE` unchanged: the official AGPL-3.0 text is already English and must remain
  verbatim.

### Verification

```text
$ grep -rlP "[\x{00C0}-\x{1EF9}]" --exclude-dir=node_modules --exclude-dir=data --exclude-dir=.git --exclude=LICENSE .
(no Markdown/source matches; only the binary screenshot and × glyphs)

$ markdown relative-link + anchor check
all relative links OK

$ npx tsc -p tsconfig.json --noEmit
typecheck OK

$ npm run verify:token   (server with VB_TOKEN=secret-token)
no token  : The server requires a token. Open the dashboard with /?token=<VB_TOKEN> ...
bad token : Invalid token or token changed. Reopen the dashboard with /?token=<VB_TOKEN>.
good token: http://127.0.0.1:8812/ | error toasts: []
OK: token UI messages verified.
```

### Notes

- Internal links and anchors were checked after translation; `ARCHITECTURE.md` now points to
  `NETWORK.md#6-webrtc`.
- The Vietnamese version remains available in git history at commit `9f3e9a7`.
- `docs/dashboard.png` was captured from a clean demo data directory; no real profile data
  is included.

### Next up

1. Add a `README.vi.md` only if a Vietnamese audience needs a maintained translation.
2. Add GitHub Actions for typecheck + `verify:proxy`.
3. Publish the `v0.2.0` release with the English assets.

---

## 2026-10-27 — Final 0.2.0 hardening (tab lifecycle, VPN, token UI)

### Context

After v0.2.0 ran end-to-end, reviewed the edge paths that were rarely touched in the demo:
tabs opened concurrently, wireproxy dying or failing to spawn, server exit, and the dashboard
with a wrong token. The goal was to leave no hanging promises, duplicate listeners, or orphan
processes behind.

### Issues & fixes

1. **`attachPage()` could run twice for the same tab.**
   `openTab()` called it directly, while `context.on("page")` also caught the tab-open event,
   so a single page got 2 `close` listeners and 2 CDP sessions.
   → Added a `WeakMap<Page, Promise<void>>` (`pageAttachments`): subsequent calls reuse the
   existing promise; the `close` listener is registered only once. If an override fails
   unexpectedly, the cache is cleared so the next attempt can retry.

2. **`shutdownAll()` did not wait for the VPN to stop.**
   `stopAllVpn()` was fire-and-forget, so the process could exit while wireproxy was still
   alive.
   → `stopAllVpn()` became `async`, using `Promise.all(stopVpn)`; `shutdownAll()`
   `await`s `stopAllVpn()`.

3. **wireproxy spawn failure → server crash.**
   `spawn()` emits `error` (ENOENT/EACCES) asynchronously; without a listener Node throws an
   unhandled `error`. At the same time `exitCode` stays `null`, so `waitForPort()` only timed
   out without reporting the real cause.
   → Added `child.once("error")` to store the error; `waitForPort()` takes a `spawnError`
   callback and throws as soon as an error appears; the final message combines
   `failed to start wireproxy: ...` + the tail log.

4. **Verify script hung after printing OK.**
   `verify-proxy.ts` left the tunnel socket half-open, `server.close()` waited forever, so
   `npm run verify:proxy` never exited (easily mistaken for a network hang).
   → `close()` has a 500 ms timeout (`timer.unref()`), and an explicit `process.exit(0)`
   after printing OK.

5. **Dashboard 401 error was hard to understand.**
   Previously it only showed "Unauthorized" from the server.
   → `api()` in `public/app.js` turns 401 into guidance: no token yet, open
   `/?token=<VB_TOKEN>`; wrong token, say the token is invalid and ask to reopen.

### Verification

```text
$ npx tsc -p tsconfig.json --noEmit
OK

$ npx tsx scripts/verify-proxy.ts
  ok  HTTP CONNECT proxy: exit IP 183.89.9.73 (TH)
  ok  SOCKS5 proxy: exit IP 183.89.9.73 (TH)
  ok  local relay (CONNECT): exit IP 183.89.9.73
  ok  local relay (plain HTTP absolute-form)
  ok  HTTP proxy wrong password: rejected (proxy: CONNECT rejected with HTTP 407)
  ok  SOCKS5 wrong password: rejected (socks5: authentication failed)
OK: proxy stack verified.        (exit 0, no longer hangs)

$ npx tsx scripts/verify-fingerprint.ts
OK: every checked value matches the generated fingerprint.

$ npx tsx scripts/verify-ui.ts http://127.0.0.1:8811
  ok  create / search / edit / duplicate / delete ...
OK: UI flow verified.

$ smoke runtime (launch → tab → thumbnail → stop)
launch: running 1 tabs streaming
thumbnail: 1745 bytes, jpeg = true
open tab: 2 tabs; active index 1
activate tab 0: 0
close tab 1: 1 tabs left
navigate: https://example.net/
still running: running streaming
stop: stopped
OK: runtime smoke verified.

$ npx tsx scripts/verify-token-ui.ts   (server VB_TOKEN=secret-token)
no token  : Server requires a token. Open the dashboard with /?token=<VB_TOKEN> ...
bad token : Invalid token or the token has changed. Reopen the dashboard with /?token=<VB_TOKEN>.
good token: http://127.0.0.1:8812/ | error toasts: []
OK: token UI messages verified.
```

### Operational notes

- `verify:token` needs a server running with `VB_TOKEN`; the script defaults to port `8812`
  (change it in `scripts/verify-token-ui.ts` if needed).
- `verify:proxy` now exits right after printing OK — usable in sequential CI.
- Tab dedup is per `Page`; it does not affect tabs opened after the profile is already running.

---

## 2026-10-27 — v0.2.0: from skeleton → usable antidetect browser

### Context

The repo started with only `types.ts`, `store.ts`, `config.ts`, `package.json`, `tsconfig`.
`package.json` declared Fastify + Playwright but there was no server, runtime, relay, UI, or
documentation. Goal for this session: complete one verifiable end-to-end cycle.

### What was done

#### 1. Foundation

- Completed `config.ts`: Chrome detection (Linux/macOS/Windows), wireproxy, env
  (`VB_DATA_DIR`, `VB_HEADLESS`, geo/VPN timeouts), version `0.2.0`.
- Extended `types.ts`: `ProxyCheckResult`, `TabInfo`, `RuntimeStatus` with tabs/streaming,
  fingerprint with `platform`, `seed`, `localePinned`, `timezonePinned`.
- `store.ts`: added `userDataDirFor()`, kept atomic writes and the path traversal guard.
- `util/random.ts`: FNV-1a + mulberry32 + picker for deterministic fingerprints.

#### 2. Fingerprint

- `lib/fingerprint.ts`:
  - detect the real Chrome version (`--version`) so UA/client hints match;
  - screen/GPU/locale/OS presets;
  - `applyGeo()` syncs locale/timezone to the IP, respecting pins;
  - init script patches navigator (webdriver, platform, hardware, languages, UA, vendor,
    `userAgentData`, plugins, `window.chrome`) + WebGL vendor/renderer;
  - `userAgentMetadata()` for CDP `Emulation.setUserAgentOverride`.
- `lib/geo-locale.ts`: country→locale/timezone table, IANA validation, ICU canonicalization,
  `languageList`.

#### 3. Network

- `lib/socks5.ts`: no-auth + RFC1929 SOCKS5 client, domain/IPv4/IPv6, exact byte reads,
  error mapping.
- `lib/upstream.ts`: direct/HTTP/HTTPS/SOCKS5 tunnel, Basic auth for HTTP CONNECT, HTTP GET
  through the tunnel, chunked decoding, timeouts for the whole stage.
- `lib/relay.ts`: local forward proxy handling **both** CONNECT and absolute-form, header
  rewriting, header/idle limits, socket cleanup.
- `lib/geo.ts`: ipwho.is → ipapi.co fallback, overall deadline.
- `lib/vpn.ts`: parse `[Socks5] BindAddress`, spawn wireproxy, wait for port, 100-line ring
  log, SIGTERM→SIGKILL.

#### 4. Runtime

- `runtime.ts`: session map, single-flight launch, prepareNetwork (VPN > proxy > direct),
  geo refresh (skip 24h when direct), Playwright context options, per-page CDP UA override,
  screencast + fallback, tab API, navigate, idempotent cleanup, `shutdownAll`.
- Added `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` when proxied.

#### 5. API + UI

- Fastify 5, static UI, normalized error handler, graceful SIGINT/SIGTERM.
- Routes: system/health/export; profile CRUD/duplicate/fingerprint/check/proxy-check;
  runtime launch/stop/session/thumbnail/tabs/navigate.
- Strict hand-written validation (`HttpError`, proxy, UUID, BCP-47, IANA, URL, tags).
- Vanilla JS UI: grid cards, live thumbnail (blob poll), search/filter, create/edit modal, test
  proxy, check IP, duplicate, regenerate, delete confirmation, tabs/URL bar, toast, system
  banner.
- Optional API token + same-origin CSRF guard + security headers.

#### 6. Verification & documentation

- `scripts/verify-fingerprint.ts`: 15 assertions between generated ↔ real page.
- `scripts/verify-proxy.ts`: spins up an auth HTTP CONNECT proxy + an auth SOCKS5 proxy; checks
  the client, relay CONNECT, relay absolute-form, wrong password.
- `scripts/verify-ui.ts`: headless Playwright runs the create → search → edit →
  duplicate → delete flow on the dashboard, catching console/page errors.
- `scripts/screenshot-ui.ts`: captures the dashboard for UI review.
- Docs: README, ARCHITECTURE, PROCESS, API, FINGERPRINT, NETWORK, SECURITY, TROUBLESHOOTING,
  ROADMAP, DEVLOG, CHANGELOG.

### Verification results

```text
$ npm run typecheck
OK

$ npm run verify:fingerprint
OK: every checked value matches the generated fingerprint.

$ npm run verify:proxy
  ok  HTTP CONNECT proxy: exit IP 183.89.9.73 (TH)
  ok  SOCKS5 proxy: exit IP 183.89.9.73 (TH)
  ok  local relay (CONNECT): exit IP 183.89.9.73
  ok  local relay (plain HTTP absolute-form)
  ok  HTTP proxy wrong password: rejected (HTTP 407)
  ok  SOCKS5 wrong password: rejected (authentication failed)
OK: proxy stack verified.

$ smoke API (VB_HEADLESS=1, temp data dir)
launch → running, "Example Domain", thumbnail JPEG
navigate → https://httpbin.org/user-agent
open tab → 2 tabs, correct active
stop → stopped

$ npm run verify:ui http://127.0.0.1:8799
  ok  create profile
  ok  search
  ok  edit profile
  ok  duplicate profile
  ok  delete "UI smoke ... (copy)"
  ok  delete "UI smoke ..."
OK: UI flow verified.

$ UI screenshot review
2 cards, states ["Running","Stopped"], no console errors.
```

### Issues found during the work & fixes

1. **Timezone mismatch between metadata and page**: Chrome returned the canonical ICU name
   (`Asia/Saigon`) while the fingerprint stored `Asia/Ho_Chi_Minh`.
   → Added `canonicalTimezone()` and used it in `generateFingerprint` + `applyGeo`.
   The fingerprint verification caught this mismatch.

2. **The first thumbnail was too large**: `Promise.all([startScreencast, captureStill])` let
   the screenshot (2400 px) overwrite the screencast frame (420 px) that arrived later.
   → Added `startView()`: start the screencast, wait up to 400 ms, fall back to a screenshot
   only if no frame arrived. Switched the fallback to `scale: "css"`.

3. **Locale pinning was overwritten by geo**: `applyGeo` always replaced locale/timezone.
   → Added `localePinned`/`timezonePinned`; the UI only sends locale/timezone when the user
     actually enters them (or clears them to drop the pin).

4. **CSRF risk from a malicious website**: a POST form to localhost could launch/stop.
   → An `onRequest` hook blocks write requests from other origins via `Origin`/`Sec-Fetch-Site`.
   Added a `Host` check when binding to loopback to block DNS rebinding.

5. **Hung timeouts**: the TLS handshake after CONNECT and the CONNECT response had no timer.
   → Added `withTimeout` + socket destroy; SOCKS5 has a timeout listener.

6. **Relay plain HTTP**: handling only CONNECT made Chrome's `http://` requests fail.
   → Parse absolute-form, rewrite to origin-form, keep the body, test it in verify-proxy.

### Decisions

- VPN **wins** over proxy; no chaining.
- A geo failure does not block launch.
- Sessions do not persist; restart = stopped.
- Fingerprint is deterministic per seed; regenerate = new seed.
- The macOS preset uses an Intel UA to stay consistent with the existing WebGL Metal/ANGLE.

### Still open / known

- Canvas/audio/fonts/geolocation/media devices are not spoofed yet.
- `navigator.plugins` is a fake object, not a complete `PluginArray`.
- Popups opened by a site may have mismatched client hints on the first request.
- No import/backup UI, no unit tests/CI yet.
- Not tested with a real wireproxy in this environment (no binary/peer); config parsing +
  lifecycle are coded, but manual testing is needed when a VPN is available.
- `--no-sandbox` is added automatically on Linux; consider making it opt-in for real desktop
  environments.

### Next up

1. `POST /api/import` + backup UI (v0.3).
2. SSE instead of polling.
3. Deterministic canvas/audio noise.
4. Test with a real HTTP auth proxy + a real WireGuard peer.
5. Unit tests for `validate.ts`, `store.ts`, `applyGeo`.
