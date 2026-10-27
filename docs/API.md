# API reference

Base URL: `http://127.0.0.1:8787`

- All data endpoints live under `/api`.
- Requests and responses are JSON (`content-type: application/json`), except thumbnails.
- If the server sets `VB_TOKEN`, add the header:

```http
x-vb-token: <token>
```

- Errors:

```json
{ "error": "profile is not running", "statusCode": 400 }
```

| Code | When |
| --- | --- |
| 200 | OK |
| 201 | Created (profile, duplicate) |
| 204 | Thumbnail has no frame yet |
| 400 | Invalid input / invalid operation (tab index, missing URL, …) |
| 401 | Missing or invalid `x-vb-token` |
| 404 | No such profile/route |
| 500 | Chrome, proxy, VPN, or system error |

`id` is a UUID. The tab index is the **current position** in `context.pages()`; always
re-read `status.tabs` after every operation.

---

## 1. System

### `GET /api/health`

```json
{
  "ok": true,
  "version": "0.3.0",
  "uptimeSec": 42,
  "profiles": 3
}
```

### `GET /api/system`

```json
{
  "version": "0.3.0",
  "node": "v22.22.1",
  "platform": "linux/x64",
  "hostname": "workstation",
  "chrome": {
    "path": "/usr/bin/google-chrome",
    "version": "150.0.7871.186",
    "found": true
  },
  "wireproxy": { "path": "/usr/local/bin/wireproxy", "found": true },
  "headless": false,
  "dataDir": "/home/me/virtual-browser/data",
  "port": 8787,
  "defaultStartUrl": "https://example.com/",
  "proxyTypes": ["http", "https", "socks5"],
  "geoProviders": ["ipwho.is", "ipapi.co"]
}
```

### `GET /api/export`

Download the metadata JSON for all profiles (no runtime, no cookies, no absolute
`userDataDir`):

```json
{
  "format": "virtual-browser/export",
  "version": 1,
  "exportedAt": "2026-10-27T16:00:00.000Z",
  "appVersion": "0.3.0",
  "profiles": [/* Profile[] */]
}
```

Header `Content-Disposition: attachment; filename="virtual-browser-YYYY-MM-DD.json"`.

> The export contains proxy credentials and VPN paths. Treat it as a secret.

---

## 2. Import, backup and restore

### `POST /api/import`

Imports an export file (the same shape as `GET /api/export`). It also accepts a
`profiles.json` store and a bare array of profiles.

```http
POST /api/import
Content-Type: application/json

{ "format": "virtual-browser/export", "version": 1, "profiles": [ ... ] }
```

- Every profile gets a **new local id** and a new `userDataDir`; existing profiles are
  never overwritten.
- The fingerprint (including its seed), proxy, tags, notes, start URL, VPN path and geo
  metadata are preserved where valid.
- A profile with invalid required fields is skipped; the rest of the import continues.
- At most 500 profiles per request. The default body limit is 16 MiB
  (`VB_MAX_IMPORT_MB`).

```json
{
  "ok": true,
  "imported": 2,
  "profiles": [/* new profiles */],
  "skipped": [{ "name": "broken", "reason": "startUrl must use http or https" }],
  "warnings": [{ "profile": "US shop", "message": "VPN config is not present..." }]
}
```

Returns `201`. Invalid JSON, unsupported format/version or too many profiles returns
`400`.

### `GET /api/backup`

Downloads a complete `.tar.gz` backup:

```text
profiles.json
profiles/<uuid>/user-data/...   # cookies, localStorage, cache, extensions
```

- All profiles must be **stopped**; otherwise `409` lists the running profiles.
- Chrome lock files (`SingletonLock`, `SingletonCookie`, `SingletonSocket`) are excluded.
- Non-regular files (symlinks, devices, sockets) are skipped so the archive is always
  restorable by this server.
- WireGuard `.conf` files normally live outside `data/` and are **not** included; back them
  up separately.
- The archive contains cookies, logins, proxy passwords and VPN paths. It is **not
  encrypted**: store it encrypted and never commit it.
- Streaming archive size is capped by `VB_MAX_BACKUP_MB` (default 2048).

Header `Content-Disposition: attachment; filename="virtual-browser-backup-YYYY-MM-DD.tar.gz"`.

### `POST /api/restore`

Restores a `.tar.gz` backup. Send the file as the raw request body:

```http
POST /api/restore
Content-Type: application/gzip

<binary tar.gz>
```

The restore is **additive**:

1. The archive is streamed to a temporary file (never buffered in memory).
2. `profiles.json` and the staging tree are validated before extraction.
3. Path traversal, absolute paths, symlinks, unsafe hardlink targets, devices, oversized
   archives and unknown entries are rejected with `400`/`413`.
4. Every profile is imported with a new id; its `profiles/<old-id>` tree is copied to the
   new data directory.
5. `profiles.json` is updated in one atomic write.

```json
{
  "ok": true,
  "imported": 2,
  "profiles": [/* new profiles */],
  "skipped": [],
  "warnings": [{ "profile": "US shop", "message": "VPN config is not present..." }]
}
```

Returns `201`. Existing profiles are never overwritten. A backup from another OS may
contain VPN paths that need fixing before launch; the profile is still imported with a
warning.

Restore limits: `VB_MAX_BACKUP_MB` (compressed size), `VB_MAX_BACKUP_ENTRIES`
(default 200000) and 4× the compressed limit for declared uncompressed size.

---

## 3. Profiles

### `GET /api/profiles`

```json
{
  "profiles": [
    {
      "id": "164684c1-4d30-4ae5-b7c5-cb1911319500",
      "name": "Smoke test",
      "tags": ["demo"],
      "startUrl": "https://example.com/",
      "userDataDir": "/.../profiles/<id>/user-data",
      "fingerprint": { "...": "effective fingerprint (geo already applied)" },
      "fingerprintSeed": "164684c1-...",
      "geo": { "...": "GeoInfo" },
      "runtime": {
        "profileId": "164684c1-...",
        "state": "running",
        "startedAt": "2026-10-27T15:58:41.702Z",
        "url": "https://example.com/",
        "title": "Example Domain",
        "tabs": [{ "index": 0, "title": "Example Domain", "url": "https://example.com/", "active": true }],
        "streaming": true,
        "proxyServer": "http://127.0.0.1:41235",
        "vpnActive": false
      }
    }
  ]
}
```

Note: `fingerprint` in the response is the **effective** fingerprint (after `applyGeo`) and
may differ from the original `fingerprint` in the JSON file. `fingerprintSeed` is the
original seed.

### `GET /api/profiles/:id`

```json
{ "profile": { /* as above, no runtime */ }, "runtime": { /* RuntimeStatus */ } }
```

### `POST /api/profiles`

Body:

```json
{
  "name": "Shopee seller — US",
  "tags": ["shopee", "us"],
  "notes": "optional",
  "startUrl": "https://example.com/",
  "osProfile": "windows",
  "locale": "en-US",
  "timezone": "America/New_York",
  "proxy": {
    "type": "socks5",
    "host": "proxy.example.com",
    "port": 1080,
    "username": "u",
    "password": "p",
    "label": "provider"
  },
  "vpn": { "kind": "wireguard", "configPath": "/home/me/us-ny.conf" }
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | ✅ | 1–80 characters |
| `tags` | ❌ | ≤ 20 tags, each ≤ 32 characters, deduplicated automatically |
| `notes` | ❌ | ≤ 8000 characters, `null` to clear |
| `startUrl` | ❌ | defaults to `VB_START_URL`, must be `http(s)://` or `about:blank` |
| `osProfile` | ❌ | `native` (default) / `windows` / `macos` |
| `locale` | ❌ | BCP-47, e.g. `en-US`; empty/`null` = inferred from geo |
| `timezone` | ❌ | IANA, e.g. `Asia/Tokyo`; empty/`null` = inferred from geo |
| `proxy` | ❌ | `null` = direct |
| `vpn` | ❌ | `null` = no VPN; `configPath` must exist |

- Sending an explicit `locale`/`timezone` **pins** that value (geo does not override it).
- Proxy port 1–65535; host without a scheme.
- `configPath` is resolved to an absolute path (supports `~/`).

Response `201`:

```json
{ "profile": { /* Profile */ } }
```

Example:

```bash
curl -X POST http://127.0.0.1:8787/api/profiles \
  -H 'content-type: application/json' \
  -d '{"name":"Demo","osProfile":"windows","startUrl":"https://example.com/"}'
```

### `PATCH /api/profiles/:id`

Same schema, all fields optional. Key points:

- `proxy: null` / `vpn: null` clears the configuration.
- `notes: null`, `tags: null` clears them.
- `locale: null` / `timezone: null` **unpins** the value and returns to auto based on geo.
- Changing `osProfile` (or locale/timezone) **regenerates the fingerprint** with the old seed.
- Changing the proxy/VPN clears `geo`, `geoError`, and `lastCheck` (because the exit IP changed).
- Network/fingerprint changes only apply from the **next launch**. A running profile does not
  restart automatically.
- Disabling the VPN while the profile is running stops that profile's wireproxy; the running
  browser keeps using the old tunnel until it stops.

Response:

```json
{ "profile": { /* Profile */ }, "runtime": { /* RuntimeStatus */ } }
```

### `DELETE /api/profiles/:id`

Stops the browser (if running), deletes the entry and the `data/profiles/<id>/` directory.

```json
{ "ok": true, "id": "164684c1-..." }
```

### `POST /api/profiles/:id/duplicate`

Creates a copy of the metadata with a new `id` and a new seed, **without copying**
user-data/cookies:

```json
{ "profile": { "name": "Smoke test (copy)", "...": "..." } }
```

### `POST /api/profiles/:id/fingerprint`

Regenerates the fingerprint (new seed). Optional body:

```json
{ "osProfile": "macos", "locale": "en-GB", "timezone": "Europe/London" }
```

- Omitting `locale`/`timezone` → inherit and keep the current pin state.
- Sending `null` → unpin and use the seeded/geo value.

```json
{ "profile": { /* Profile */ } }
```

### `GET /api/profiles/:id/fingerprint`

```json
{
  "stored": { /* fingerprint stored in profiles.json */ },
  "effective": { /* after applyGeo */ }
}
```

### `POST /api/profiles/:id/check`

Looks up the IP/geo through the profile's own proxy/VPN, saving `geo`, `lastCheck`, and
`geoError`.

- If a VPN is configured and not running: wireproxy starts automatically and stops once the
  check finishes (unless the profile is running).
- If `localePinned`/`timezonePinned` = true, the fingerprint keeps the corresponding part
  unchanged.

```json
{
  "check": {
    "ok": true,
    "checkedAt": "2026-10-27T15:58:37.270Z",
    "latencyMs": 554,
    "geo": {
      "ip": "183.89.9.73",
      "country": "Thailand",
      "countryCode": "TH",
      "region": "Bangkok",
      "city": "Bangkok",
      "timezone": "Asia/Bangkok",
      "isp": "Advanced Wireless Network Company Limited",
      "org": "Advanced Wireless Network Company Limited",
      "checkedAt": "2026-10-27T15:58:37.270Z",
      "provider": "ipwho.is",
      "latencyMs": 552
    }
  },
  "profile": { /* updated Profile */ }
}
```

Network errors still return `200` with `check.ok = false` and `check.error`; this is a check
result, not a request error.

### `POST /api/proxy/check`

Tests a proxy ad hoc, **storing nothing** (used by the create/edit form):

```json
{ "proxy": { "type": "http", "host": "127.0.0.1", "port": 8080, "username": "u", "password": "p" } }
```

`"proxy": null` to test direct.

```json
{ "check": { "ok": true, "latencyMs": 312, "geo": { "...": "..." } } }
```

---

## 4. Runtime

### `POST /api/profiles/:id/launch`

Opens Chrome. If the profile is already `starting|running`, returns the current status (no
duplicate launch).

Can take 2–15 s: VPN startup + geo lookup + Chrome + first page.

```json
{
  "status": {
    "profileId": "164684c1-...",
    "state": "running",
    "startedAt": "2026-10-27T15:58:41.702Z",
    "url": "https://example.com/",
    "title": "Example Domain",
    "tabs": [{ "index": 0, "title": "Example Domain", "url": "https://example.com/", "active": true }],
    "streaming": true,
    "vpnActive": false
  }
}
```

Configuration errors (Chrome missing, wireproxy missing, bad config) → 500 with a message.

### `POST /api/profiles/:id/stop`

Closes the profile's browser, relay, and VPN.

```json
{ "status": { "profileId": "164684c1-...", "state": "stopped" } }
```

### `GET /api/profiles/:id/session`

```json
{ "status": { /* RuntimeStatus */ } }
```

Profile not running → `state: "stopped"`, no `tabs`.

### `GET /api/profiles/:id/thumbnail`

- `200 image/jpeg` — latest frame from the screencast (usually 420 px wide), or a screenshot
  fallback.
- `204` — no frame yet (not launched / just launched).
- `Cache-Control: no-store`.

Use this to poll every 1–2 s. It does not keep the connection open.

### `POST /api/profiles/:id/navigate`

Navigates the active tab:

```json
{ "url": "https://example.org" }
```

- Missing scheme → `https://` is added automatically.
- Accepts `about:blank`.
- `waitUntil: domcontentloaded`, 30 s timeout.
- Returns `{ "status": RuntimeStatus }`.

### `POST /api/profiles/:id/tabs`

Opens a new tab and switches to it:

```json
{ "url": "https://example.org" }
```

`url` is optional (defaults to `about:blank`). Response is the same as `navigate`.

### `POST /api/profiles/:id/tabs/:index/activate`

Switches the active tab (index from `status.tabs`).

### `DELETE /api/profiles/:id/tabs/:index`

Closes the tab. If the active tab is closed, the runtime selects the first remaining tab.

---

## 5. Static UI

| Route | Content |
| --- | --- |
| `GET /` | `public/index.html` dashboard |
| `GET /styles.css` | CSS |
| `GET /app.js` | JS |

No client-side router; all operations go through `/api`.
