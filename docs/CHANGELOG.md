# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/), versions follow
[SemVer](https://semver.org/).

---

## [Unreleased]

### Changed

- Documentation and dashboard messages are now **English-only** for international
  distribution. The Vietnamese docs remain in git history (`9f3e9a7`).

### Added

- Root `SECURITY.md` with private vulnerability reporting, scope, response expectations,
  and safe harbor.
- Marketing-oriented English README with a cloud-browser comparison and acceptable-use
  section.

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
