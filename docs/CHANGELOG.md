# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow
[SemVer](https://semver.org/).

---

## [0.3.0] — 2026-10-28

### Added

- **JSON import/export**: `POST /api/import` accepts exports or a bare profile array,
  assigns new ids/data dirs, preserves fingerprints (including the seed), and skips invalid
  profiles without aborting the batch.
- **Full backup**: `GET /api/backup` streams `.tar.gz` with `profiles.json` and every
  `user-data/` tree. Refuses to run while profiles are open; Chrome lock files and
  non-regular files (symlinks/devices) are skipped so the archive is always restorable.
- **Safe additive restore**: `POST /api/restore` validates tar paths, entry types, entry
  count and size; rejects traversal, absolute paths, symlinks, unsafe hardlink targets and
  devices; copies browser data to new id directories and writes the store atomically.
- **Serialized store mutations**: concurrent imports/edits are queued so two snapshots cannot
  rename over each other and drop profiles.
- **Dashboard Data menu**: export/import JSON, download a full backup, restore an archive,
  with confirmations and secret warnings.
- Root `SECURITY.md` with private vulnerability reporting, scope, response expectations,
  and safe harbor.
- Marketing-oriented English README with a cloud-browser comparison and acceptable-use
  section.
- `npm run verify:data` (HTTP) and `npm run verify:ui-data` (dashboard) smoke tests.

### Changed

- Documentation and dashboard messages are now **English-only** for international
  distribution. The Vietnamese docs remain in git history (`9f3e9a7`).
- Version bumped to `0.3.0`; `@fastify/static` updated to 10.1.8 (security fixes).

### Security

- Restore is the only endpoint that accepts an archive: raw `application/gzip` streamed to
  a temp file, never buffered; path traversal, symlinks, unsafe hardlink targets, devices,
  unknown roots, oversized archives and >200k entries are rejected.
- Backup refuses while any profile session exists, so SQLite/cookie files are not copied
  mid-write.
- Static files now use `dotfiles: "deny"`.
- Profile deletion is confined to `profiles/<uuid>/`, never the profiles root or a parent
  directory, even with a hand-edited store.

### Known limitations

- Backups are unencrypted and contain cookies + proxy passwords.
- JSON export is metadata only; use a full backup for browser data.
- Browser download buffers large backups in memory.

---

## [0.2.0] — 2026-10-27

### Added

- **Full proxy support**: HTTP, HTTPS, SOCKS5, with username/password support.
- **Local relay** without auth for Chrome, handles CONNECT + absolute-form, hides
  credentials from the command line.
- **WireGuard VPN** via `wireproxy`: parse `[Socks5] BindAddress`, spawn/wait for port/stop,
  log the tail of errors.
- **Geo sync**: look up the IP through the actual proxy/VPN, fallback `ipwho.is` → `ipapi.co`,
  apply locale + timezone (canonical ICU) to the fingerprint.
- **Locale/timezone pinning**: keeps the user's choice, not overwritten by geo.
- **Enhanced fingerprint**:
  - UA + client hints matching the actual installed Chrome;
  - platform, locale, timezone, screen, DPR, color scheme;
  - WebGL vendor/renderer, hardwareConcurrency, deviceMemory;
  - `navigator.webdriver=false`, plugins, `window.chrome`;
  - init script for every frame + CDP `Emulation.setUserAgentOverride`.
- **WebRTC mitigation**: `disable_non_proxied_udp` when the profile has a proxy/VPN.
- **Runtime**:
  - single-flight launch/stop, cleanup of Chrome/relay/VPN;
  - live thumbnail via CDP screencast + screenshot fallback;
  - tab management: list/open/close/switch, URL bar navigation;
  - graceful shutdown.
- **Profile**: tags, notes, start URL, OS profile, duplicate, regenerate fingerprint.
- **API**: health/system/export, profile CRUD, check IP, test proxy, launch/stop/session/
  thumbnail/tabs/navigate.
- **UI dashboard**: dark theme, search/filter, card fingerprint facts, geo, live view,
  create/edit modal, test proxy, delete confirmation, toast, system banner.
- **Security**: optional `VB_TOKEN`, same-origin CSRF guard, security headers, strict
  input validation.
- **Verification**: `verify:fingerprint` (15 assertions), `verify:proxy` (HTTP/SOCKS5 auth +
  relay + wrong password), `verify:ui` (dashboard CRUD), `verify:token` (missing/
  invalid token messages), `ui:shot`, `verify` runs typecheck + proxy + fingerprint.
- **Documentation**: README, ARCHITECTURE, PROCESS, API, FINGERPRINT, NETWORK, SECURITY,
  TROUBLESHOOTING, ROADMAP, DEVLOG.

### Changed

- `Fingerprint` adds `platform`, `seed`, `localePinned`, `timezonePinned`.
- `RuntimeStatus` adds `tabs`, `streaming`, `proxyServer`, `vpnActive`.
- `Profile` adds `tags`, `lastCheck`, `geoError`.
- Profile list returns the **effective fingerprint** (with geo applied) + `fingerprintSeed`.
- `/api/profiles` returns runtime alongside each profile.
- Changing the proxy/VPN clears stale geo (because the exit IP changed).

### Fixed

- Timezone metadata mismatched the page due to ICU aliases (`Asia/Ho_Chi_Minh` vs `Asia/Saigon`).
- Screenshot fallback overwrote a small screencast frame.
- Locale pinning was overwritten by geo.
- CSRF risk from websites to the localhost API.
- Hung timeouts on CONNECT responses and TLS handshakes after the tunnel.
- Relay handling only CONNECT broke `http://` absolute-form requests.
- New tabs got two `close`/CDP listeners because `openTab()` and the `page` event both ran.
- `wireproxy` spawn errors (ENOENT/EACCES) crashed the server because of a missing `error` listener.
- `shutdownAll()` did not wait for `wireproxy` to fully stop.
- `verify:proxy` hung after printing OK because the tunnel socket stayed open.
- The 401 message on the dashboard did not explain how to reopen with a token.

### Security

- Added `VB_TOKEN`, CSRF guard, DNS-rebinding Host check, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`.
- Restricted profile deletion paths within `PROFILES_DIR`.
- No proxy credentials on the Chrome command line.

### Known limitations

- Canvas/audio/fonts/geolocation/media devices are not spoofed yet.
- `navigator.plugins` is a fake object, not yet a `PluginArray`.
- No backup import, no unit tests/CI yet.
- Runtime sessions do not persist across a server restart.

---

## [0.1.0] — 2026-10-27

### Added

- Project skeleton: `types`, `config`, atomic JSON `store`.
- Basic fingerprint generator (UA, locale, timezone, screen, WebGL).
- Playwright persistent context.
- Chrome/wireproxy detection.
- Initial dashboard.
