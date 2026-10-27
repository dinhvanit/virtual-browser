# Architecture

This document describes **how the system runs**, not just which file does what. Read it
alongside [NETWORK](NETWORK.md) and [FINGERPRINT](FINGERPRINT.md).

---

## 1. Design goals

1. **Real isolation**: each profile has its own Chrome `user-data-dir`. No shared cookies,
   cache, localStorage, or extensions.
2. **Correct egress**: every request from a profile goes through the configured proxy/VPN;
   the IP used for the geo lookup must also go through that same path.
3. **Consistency**: UA, client hints, platform, locale, timezone, screen, WebGL, and hardware
   must not contradict each other. Timezone/locale must match the exit IP.
4. **Observability**: see the running browser, tabs, URL, live images, and network errors.
5. **Local-first**: no cloud, no telemetry, data lives in `data/`.

---

## 2. Module map

| File | Responsibility |
| --- | --- |
| `src/config.ts` | paths, Chrome/wireproxy detection, env, timeouts, version |
| `src/types.ts` | all shared data contracts |
| `src/store.ts` | atomic read/write of `profiles.json`, safe creation/removal of user-data-dir |
| `src/util/random.ts` | FNV-1a hash, mulberry32 PRNG, seed picker, id |
| `src/lib/fingerprint.ts` | generate fingerprint from seed, apply geo, init script, UA metadata |
| `src/lib/geo-locale.ts` | country → locale/timezone mapping, canonical timezone, IANA validation |
| `src/lib/socks5.ts` | SOCKS5 client handshake (no-auth + username/password) |
| `src/lib/upstream.ts` | open a tunnel to the target via direct/HTTP/HTTPS/SOCKS5; HTTP GET through the proxy |
| `src/lib/relay.ts` | local HTTP forward proxy, forwarding CONNECT + absolute-form requests |
| `src/lib/geo.ts` | IP/geo lookup through the correct proxy, 2-provider fallback, `checkProxy` |
| `src/lib/vpn.ts` | spawn/stop `wireproxy`, parse `[Socks5] BindAddress`, wait for the port |
| `src/runtime.ts` | session map, launch/stop, Playwright context, screencast, tabs, navigate |
| `src/server/index.ts` | Fastify, static UI, auth token, error handler, graceful shutdown |
| `src/server/routes/*.ts` | REST endpoints grouped by area |
| `src/server/validate.ts` | input validation, `HttpError` |
| `public/*` | vanilla JS dashboard (no build step) |
| `scripts/verify-*.ts` | fingerprint and proxy stack verification |

Dependency flow (arrow = import):

```text
server ─► runtime ─► fingerprint ─► geo-locale
   │          │            │
   │          ├─► relay ───┴─► upstream ─► socks5
   │          ├─► geo ───────► upstream
   │          ├─► vpn
   │          └─► store
   └─► validate / routes
```

There are no import cycles. `runtime.ts` imports only `store` (never the other way around).

---

## 3. Data model

### 3.1 `Profile`

```jsonc
{
  "id": "164684c1-...",              // UUID, also the initial fingerprint seed
  "name": "Shopee seller — US",
  "notes": "2FA on phone A",
  "tags": ["shopee", "us"],
  "createdAt": "2026-10-27T15:58:37.281Z",
  "updatedAt": "2026-10-27T15:58:44.010Z",
  "userDataDir": "/.../data/profiles/<id>/user-data",
  "startUrl": "https://example.com/",
  "proxy": {
    "type": "socks5",                // http | https | socks5
    "host": "proxy.example.com",
    "port": 1080,
    "username": "u",                 // optional
    "password": "p",                 // optional
    "label": "provider"
  },
  "vpn": { "kind": "wireguard", "configPath": "/home/me/us-ny.conf" },
  "fingerprint": { "...": "see below" },
  "geo": { "...": "see GeoInfo" },
  "geoError": "ipwho.is returned HTTP 502 | ...",
  "lastLaunchedAt": "2026-10-27T15:58:44.010Z",
  "lastCheck": { "ok": true, "checkedAt": "...", "latencyMs": 263, "geo": { } }
}
```

- `proxy` and `vpn` are independent in data, but the **VPN wins** at launch (see §5).
- `geo` is the result of the most recent check; it may be older than the current IP if the
  proxy rotates IPs.
- `lastCheck` also keeps failures (`ok: false`, `error`).

### 3.2 `Fingerprint`

```jsonc
{
  "osProfile": "windows",            // native | windows | macos
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/150.0.7871.186 ...",
  "chromeVersion": "150.0.7871.186", // taken from the real Chrome
  "platform": "Win32",               // navigator.platform
  "locale": "th-TH",
  "timezone": "Asia/Bangkok",
  "screen": { "width": 1920, "height": 1080 },
  "deviceScaleFactor": 1.25,
  "webglVendor": "Google Inc. (Intel)",
  "webglRenderer": "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  "hardwareConcurrency": 8,
  "deviceMemory": 8,
  "colorScheme": "light",
  "seed": "164684c1-...",
  "localePinned": false,             // true = do not let geo override the locale
  "timezonePinned": false
}
```

`osProfile: "native"` means **no OS spoofing**: UA/platform follow the host, and
WebGL/hardware are not patched (avoiding a bogus fake of the real hardware).
`windows`/`macos` patch everything.

### 3.3 `GeoInfo`

`ip, country, countryCode, region, city, timezone, isp, org, checkedAt, provider,
latencyMs`. Current providers: `ipwho.is`, fallback `ipapi.co`.

### 3.4 `RuntimeStatus` (not persisted)

`state: stopped | starting | running | error`, `startedAt`, `error`, `url`, `title`,
`tabs[]`, `streaming`, `proxyServer`, `vpnActive`.

Server restart → empty session map → every profile shows `stopped`, whether or not the old
Chrome is still alive. This is intentional: there is no process supervisor.

---

## 4. Profile creation flow

```text
POST /api/profiles
  ├─ validate name/url/proxy/vpn/locale/timezone
  ├─ id = uuid
  ├─ fingerprint = generateFingerprint({ seed: id, osProfile, locale?, timezone? })
  ├─ mark localePinned/timezonePinned if the client sends a concrete value
  ├─ userDataDir = data/profiles/<id>/user-data
  └─ addProfile() → write JSON atomically
```

Until the first launch, the user-data directory is not created (Playwright creates it).
Until an IP check runs, `geo` is empty; the dashboard shows "IP not checked yet".

Duplicating a profile: new id, new seed, copy proxy/VPN/tags/notes, **do not** copy
user-data.

---

## 5. Launch flow (the most important one)

```mermaid
sequenceDiagram
    participant UI as Dashboard
    participant API as Fastify
    participant RT as runtime.ts
    participant NET as relay/vpn
    participant GEO as geo.ts
    participant CH as Chrome (Playwright)

    UI->>API: POST /profiles/:id/launch
    API->>RT: launchProfile(profile)
    RT->>RT: state = starting (session map)
    alt VPN configured
        RT->>NET: startVpn() → wireproxy
        NET-->>RT: SOCKS5 port 127.0.0.1:P
        Note over RT: browser proxy = socks5://127.0.0.1:P
    else proxy configured
        RT->>NET: startRelay(proxy)
        NET-->>RT: http://127.0.0.1:Q (no auth)
        Note over RT: browser proxy = relay URL
    else direct
        Note over RT: no proxy
    end
    RT->>GEO: lookupGeo(profile's own proxy)
    GEO-->>RT: ip/country/timezone (+ latency)
    RT->>RT: profile.fingerprint = applyGeo(fp, geo)
    RT->>CH: launchPersistentContext(userDataDir, options)
    RT->>CH: addInitScript(fingerprintInitScript)
    RT->>CH: CDP Emulation.setUserAgentOverride (per page)
    RT->>CH: goto(startUrl)
    RT->>CH: Page.startScreencast + screenshot fallback
    RT->>RT: state = running, save lastLaunchedAt
    RT-->>API: RuntimeStatus
```

### 5.1 Network priority

1. `profile.vpn` (WireGuard) — if present, use wireproxy's local SOCKS5.
2. `profile.proxy` — if present, stand up a local relay.
3. Direct.

A proxy is **not chained** behind the VPN. Chaining would require changing the design;
currently the VPN is the last network layer.

### 5.2 Geo refresh

- With a proxy/VPN: **always** look up again at launch (the IP may have rotated).
- Direct: reuse `geo` if `checkedAt` < 24h, avoiding unnecessary latency.
- Geo errors **do not block launch**. `geoError` is stored; the browser still opens with the
  old fingerprint.
- If `localePinned`/`timezonePinned` = true, `applyGeo` keeps the user-selected value.

### 5.3 Playwright context options

```ts
executablePath: CHROME_PATH
headless: HEADLESS
args: [--no-first-run, --disable-blink-features=AutomationControlled,
       --force-webrtc-ip-handling-policy=disable_non_proxied_udp (when a proxy is configured),
       --lang=..., --window-size=...]
ignoreDefaultArgs: ["--enable-automation"]
userAgent, locale, timezoneId, viewport, screen, deviceScaleFactor, colorScheme
extraHTTPHeaders: { "Accept-Language": ... }
proxy: { server: relayOrSocks }
```

Real Chrome + `playwright-core` (no bundled Chromium) to keep codecs, the "Google Chrome"
brand, and real TLS/JA3.

### 5.4 WebRTC leak prevention

When a proxy/VPN is configured, add
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp` so WebRTC does not use UDP
directly from the real interface. This is a **mitigation**, not proof of zero leakage; see
[NETWORK §6](NETWORK.md#6-webrtc).

---

## 6. Local relay — why is it needed?

Chrome receives the proxy via `--proxy-server`/Playwright `proxy.server`. Chrome does **not**
reliably send the username/password from URLs like `http://user:pass@host:port`, especially
for SOCKS5. Therefore:

```text
Chrome ──► 127.0.0.1:Q (relay, no auth)
              │  CONNECT host:port   (or absolute-form GET)
              ▼
        connectUpstream(profile.proxy)
              ├─ http/https: TCP/TLS to the proxy + CONNECT + Proxy-Authorization
              └─ socks5: greeting → auth → CONNECT domain/IP
              ▼
        target
```

The relay supports:

- `CONNECT host:port` — used for HTTPS and (with Chrome) most requests as well.
- absolute-form `GET http://...` — rewritten to origin-form before being pushed into the tunnel.
- stripping `Proxy-Connection` and `Proxy-Authorization` from Chrome's requests.
- a 64 KB header limit, a 120 s socket timeout, and closing both ends when one dies.

The relay binds `127.0.0.1` on a random port. There is no auth because it only serves the
local Chrome; it closes when the profile stops.

Details + tests: [NETWORK](NETWORK.md).

---

## 7. Session lifecycle in the runtime

```text
stopped ──launch──► starting ──ok──► running
                        │               │
                        └──error──► error ──launch again──► starting
                                        │
running ──context.close()/stop──► stopped (session removed)
error   ──dispose──► keep the error entry for the UI to read; the next launch removes it
```

- `sessions: Map<profileId, Session>` in RAM.
- `Session` holds `BrowserContext`, `RelayHandle`, `vpnActive`, `activePage`, the CDP
  screencast, the latest JPEG frame (base64), and `cleaned`.
- **Single-flight**: while `starting|running`, a launch call returns the current status.
- `disposeSession()` is idempotent: stop screencast → close context → close relay → stop VPN.
  `context.on("close")` also calls dispose (guarded by `cleaned`).
- When the active tab closes, the runtime selects the first remaining tab and switches the
  screencast.
- Tabs are indexed by `context.pages()`; the index may change after a tab closes — the UI
  always re-fetches the list after every action/poll.

### Screencast

- CDP `Page.startScreencast` (JPEG q=45, maxWidth=420, everyNthFrame=4) for the active tab.
- Each frame is stored as base64 and acked immediately so Chrome keeps sending.
- If no frame arrives within 400 ms (static tab/headless not supported), fall back to
  `page.screenshot(scale: "css")`.
- `GET /api/profiles/:id/thumbnail` returns the latest frame, `204` if there is none.
- On tab change/stop, the old screencast is stopped and CDP detached.

---

## 8. API & UI

- Fastify 5, JSON, static `public/`.
- All routes live under `/api`; the UI calls the same origin, so no CORS is needed.
- Normalized errors: `{ "error": "...", "statusCode": 400 }`.
- `VB_TOKEN` (optional) → an `onRequest` hook blocks `/api/*` when `x-vb-token` is missing.
- Vanilla JS UI, no bundler: polls `/api/profiles` every 3 s and the thumbnail every 1.8 s.
  Reconciles by `card._sig` so the DOM is not rebuilt when only the runtime state changes
  (keeping focus in the URL bar).
- See [API](API.md).

---

## 9. Storage & durability

- JSON is written through a temp file and then `rename`d → avoids corrupting the file midway.
- No migration framework; `DB.version = 1`. When the schema changes you must:
  1. Bump the version.
  2. Write a migrate function in `initStore()` (read → transform → write back).
  3. Record it in [CHANGELOG](CHANGELOG.md) + [PROCESS](PROCESS.md).
- `removeProfile()` only deletes the directory if the resolved path is inside `PROFILES_DIR`
  (path traversal protection).
- `profiles.json` contains secrets (proxy passwords). Do not commit `data/` (already covered
  by `.gitignore`).

---

## 10. Error handling

| Situation | Behavior |
| --- | --- |
| Chrome not found | launch returns 500 with a clear message; `/api/system` reports `found:false` |
| Wrong proxy auth | relay receives 407 → Chrome shows a proxy error; IP check returns a 407 error |
| Proxy hangs | 15 s timeout in `connectUpstream`, 9 s for geo; launch continues |
| Geo error | store `geoError`, launch continues |
| VPN missing binary/config/port | launch fails before Chrome opens; wireproxy is killed |
| Bad start URL | the browser still opens; `session.error` is shown on the card |
| Tab crashes/closes | screencast switches to another tab; CDP errors are swallowed |
| Server SIGINT/SIGTERM | close Fastify → stop all sessions → stop VPN → exit |

Philosophy: **network/geo errors must not prevent the browser from opening**, but
configuration errors (missing Chrome, missing wireproxy) must fail early and clearly.

---

## 11. Design decisions & trade-offs

| Decision | Reason | Trade-off |
| --- | --- | --- |
| Real Chrome, no bundled Chromium | commercial fingerprint, codecs, real TLS | depends on the user's machine |
| Local relay for every proxy | auth works with Chrome | one extra local TCP hop |
| VPN takes priority over proxy | avoids confusing double-hops | no chaining |
| Screencast instead of VNC | no extra dependency/port | only the active tab, ≤ 420 px |
| JSON store | simple, easy to back up | not suitable for multi-process |
| Sessions in RAM | no runtime DB needed | server restart loses state |
| Fingerprint generated from a seed | reproducible, not random per launch | changing the fingerprint requires "regenerate" |
| Automatic geo | locale/timezone match the IP | launch is ~0.3–2 s slower; needs Internet |

---

## 12. Extension points

- **Add a proxy type** (SSH, Tor): add it to `ProxyType`, `connectUpstream`, validation, and
  the UI.
- **Add a VPN kind**: extend `VpnConfig`, `vpn.ts`, and the `prepareNetwork` branch.
- **Add a fingerprint surface** (canvas/audio/fonts): add fields to `Fingerprint`, patch them
  in `fingerprintInitScript`, and add assertions in `scripts/verify-fingerprint.ts`.
- **Add a geo provider**: add a `lookupX` function and include it in the fallback array in
  `lookupGeo`.
- **Realtime events**: replace polling with SSE/WebSocket, emitting events from the runtime.
