# Roadmap

Mark `[x]` once the item is merged + verified + documented. Do not add work without
acceptance criteria here.

---

## v0.1 — Foundation (done)

- [x] Atomic JSON profile store
- [x] Types/config/Chrome detection
- [x] Basic fingerprint generator
- [x] Playwright persistent context
- [x] Minimal dashboard

## v0.2 — Usable antidetect (done)

### Network
- [x] HTTP/HTTPS/SOCKS5 proxies with auth
- [x] Local relay (CONNECT + absolute-form)
- [x] SOCKS5 client (RFC 1928 + 1929)
- [x] Timeout on every handshake + socket destroy
- [x] WireGuard through wireproxy (spawn, parse port, stop, log)
- [x] Geo lookup through the correct proxy/VPN, 2-provider fallback
- [x] `force-webrtc-ip-handling-policy` when proxied
- [x] `npm run verify:proxy` (HTTP auth, SOCKS5 auth, relay, wrong password)

### Fingerprint
- [x] Seeded PRNG, UI/version taken from the real Chrome
- [x] UA + client hints via CDP + init script
- [x] platform/locale/timezone/screen/DPR/WebGL/hardware/plugins/webdriver
- [x] OS profile native/windows/macos
- [x] Geo → canonical locale/timezone, pin locale/timezone
- [x] `npm run verify:fingerprint` (15 assertions)

### Runtime / UI
- [x] Single-flight launch/stop, idempotent cleanup
- [x] Live screencast JPEG + fallback screenshot
- [x] Tab list/open/close/switch, URL bar
- [x] Dashboard: search/filter, tags, geo, fingerprint facts, toast, modal
- [x] Per-profile IP check + ad-hoc proxy test
- [x] Duplicate, regenerate fingerprint, delete
- [x] Export JSON
- [x] CSRF same-origin guard, security headers, optional `VB_TOKEN`

### Operations
- [x] Graceful shutdown closes Chrome/relay/VPN
- [x] API reference, architecture, process, security, troubleshooting docs
- [x] Devlog + changelog
- [x] `npm run verify:ui` (create/search/edit/duplicate/delete) + `npm run ui:shot`

---

## v0.3 — Restore & data (high priority)

### Import / backup / restore
- [ ] `POST /api/import` accepts an export file and creates new profiles (does not overwrite existing ids).
- [ ] Optional `GET /api/export?full=1` bundles user-data too (`.tar.gz`) — with a clear security
      warning.
- [ ] Backup/restore from the UI, with confirmation.
- [ ] **Acceptance**: export 3 profiles → delete → import → metadata/proxy/fingerprint match;
      user-data is restored only when full is selected.

### Profile organization
- [ ] Groups/folders (one level), assigned by drag-and-drop or dropdown.
- [ ] Sort by name/last run/status.
- [ ] Bulk actions: launch/stop/delete multiple profiles (with confirmation).
- [ ] **Acceptance**: a bulk action on 20 profiles does not block the UI for more than 2 s
      (optimistic updates + polling).

### Fingerprint data
- [ ] Show saved `localePinned/timezonePinned` clearly on the card ("pinned" badge).
- [ ] Fingerprint presets (Windows 11 + RTX, MacBook M2…) for quick selection.
- [ ] Keep fingerprint history (on each regenerate) for auditing.
- [ ] **Acceptance**: changing a preset does not lose proxy/notes; history is read-only.

---

## v0.4 — Deeper fingerprint

- [ ] Seed-deterministic canvas noise (2D + WebGL readPixels).
- [ ] AudioContext fingerprint (light buffer noise, without breaking audio).
- [ ] Font list per OS profile (spoof `document.fonts.check` + measurement).
- [ ] Geolocation API driven by geo (coordinates + simulated "prompt" permission).
- [ ] Stable media device count/labels.
- [ ] `navigator.connection`, battery, bluetooth/USB policy.
- [ ] Automated WebRTC test (not just a flag).
- [ ] **Acceptance**: `verify:fingerprint` grows to ≥ 25 assertions; 3 seeds produce different
      canvas hashes, the same seed produces a stable hash; Google Maps/YouTube keep working.

---

## v0.5 — Small-scale operations

- [ ] SSE/WebSocket pushing state + frames instead of polling (fewer requests).
- [ ] Proxy pool + manual rotation (one proxy per profile, with health checks).
- [ ] Periodic health checks (opt-in), alert on dead proxies.
- [ ] Import cookies/sessions from a JSON file (Netscape or Playwright storage state) —
      with a risk warning.
- [ ] Load unpacked extensions per profile.
- [ ] Custom Chrome args per profile (whitelist).
- [ ] **Acceptance**: 10 running profiles, dashboard updates < 1 s, server CPU < 5% when idle.

---

## v0.6 — Packaging & quality

- [ ] Automated tests for store/validate/fingerprint (node:test or vitest).
- [ ] API tests with `fastify.inject()`.
- [ ] CI (GitHub Actions): typecheck + verify:proxy + unit tests (no Chrome needed for PRs).
- [ ] Docker image (Chrome + wireproxy + app), mount `data/`.
- [ ] `npm pack`/binary packaging (pkg/bun) — decide after measuring size.
- [x] Basic `verify:ui` with Playwright (CRUD + console errors) — launch/stop already have API
      smoke coverage; extend the UI test to launch once a stable proxy is available.
- [ ] **Acceptance**: the PR fails if typecheck/tests fail; the image runs with `VB_HEADLESS=1`.

---

## v1.0 — Stability

- [ ] Schema migration framework (`db.version` > 1) + migration tests.
- [ ] Operation audit log (create/delete/launch/check) with timestamps, no secrets.
- [ ] Encrypted periodic backups (age/gpg).
- [ ] Complete "safe operations" documentation + threat model review.
- [ ] API versioning (`/api/v1`) or a backward-compatibility commitment.
- [ ] **Acceptance**: upgrading from v0.2 loses no profiles/cookies; rollback works.

---

## Technical debt / known gaps

| Issue | Impact | Proposal |
| --- | --- | --- |
| Sessions live only in RAM | restart loses state, orphaned Chrome | process registry/supervisor (v0.6) |
| 3 s polling | many requests with many profiles | SSE (v0.5) |
| `plugins` is a fake object | detectable by advanced scripts | build a complete fake `PluginArray` (v0.4) |
| Client hints on the first popup | header mismatch | patch earlier via CDP auto-attach |
| macOS preset uses an Intel UA | not diverse | add an Apple Silicon preset |
| No import | manual restore | v0.3 |
| No unit tests | risky refactoring | v0.6 |
| `--no-sandbox` on Linux | reduces process isolation | use only in containers; consider an opt-in flag |
| Proxy passwords in plain text | exposed if the file leaks | encrypt the store with a passphrase (v1.0) |
| No limit on running profiles | RAM exhaustion | warning + configurable limit (v0.5) |

---

## Prioritization principles

1. **Never lose user data** before any new feature.
2. **Correct networking** (no IP leaks) before **pretty fingerprints**.
3. **Consistency** before **more surfaces**.
4. **Measurable** before **optimization**: add verify/assert before optimizing on gut feeling.
5. **Local-first**: do not add cloud dependencies unless truly necessary.
