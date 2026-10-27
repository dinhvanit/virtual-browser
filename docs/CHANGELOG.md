# Changelog

Định dạng dựa trên [Keep a Changelog](https://keepachangelog.com/), version theo
[SemVer](https://semver.org/).

---

## [0.2.0] — 2026-10-27

### Added

- **Proxy đầy đủ**: HTTP, HTTPS, SOCKS5, hỗ trợ username/password.
- **Relay local** không auth cho Chrome, xử lý CONNECT + absolute-form, che credential
  khỏi command line.
- **WireGuard VPN** qua `wireproxy`: parse `[Socks5] BindAddress`, spawn/chờ port/stop,
  log lỗi cuối.
- **Geo sync**: tra IP qua đúng proxy/VPN, fallback `ipwho.is` → `ipapi.co`, áp locale +
  timezone (canonical ICU) vào fingerprint.
- **Pin locale/timezone**: giữ lựa chọn người dùng, không bị geo ghi đè.
- **Fingerprint nâng cao**:
  - UA + client hints theo Chrome thật đang cài;
  - platform, locale, timezone, screen, DPR, color scheme;
  - WebGL vendor/renderer, hardwareConcurrency, deviceMemory;
  - `navigator.webdriver=false`, plugins, `window.chrome`;
  - init script cho mọi frame + CDP `Emulation.setUserAgentOverride`.
- **WebRTC mitigation**: `disable_non_proxied_udp` khi profile có proxy/VPN.
- **Runtime**:
  - launch/stop single-flight, cleanup Chrome/relay/VPN;
  - live thumbnail qua CDP screencast + fallback screenshot;
  - quản lý tab: list/mở/đóng/chuyển, URL bar điều hướng;
  - graceful shutdown.
- **Profile**: tags, notes, start URL, OS profile, duplicate, regenerate fingerprint.
- **API**: health/system/export, profile CRUD, check IP, test proxy, launch/stop/session/
  thumbnail/tabs/navigate.
- **UI dashboard**: dark theme, search/filter, card fingerprint facts, geo, live view,
  modal tạo/sửa, test proxy, confirm delete, toast, system banner.
- **Bảo mật**: `VB_TOKEN` optional, CSRF same-origin guard, security headers, validate
  input chặt.
- **Kiểm chứng**: `verify:fingerprint` (15 assert), `verify:proxy` (HTTP/SOCKS5 auth +
  relay + wrong password), `verify:ui` (CRUD dashboard), `verify:token` (thông báo thiếu/
  sai token), `ui:shot`, `verify` chạy typecheck + proxy + fingerprint.
- **Tài liệu**: README, ARCHITECTURE, PROCESS, API, FINGERPRINT, NETWORK, SECURITY,
  TROUBLESHOOTING, ROADMAP, DEVLOG.

### Changed

- `Fingerprint` thêm `platform`, `seed`, `localePinned`, `timezonePinned`.
- `RuntimeStatus` thêm `tabs`, `streaming`, `proxyServer`, `vpnActive`.
- `Profile` thêm `tags`, `lastCheck`, `geoError`.
- Profile list trả **effective fingerprint** (đã áp geo) + `fingerprintSeed`.
- `/api/profiles` trả runtime kèm mỗi profile.
- Đổi proxy/VPN xoá geo cũ (vì IP thoát đã đổi).

### Fixed

- Timezone metadata lệch page do alias ICU (`Asia/Ho_Chi_Minh` vs `Asia/Saigon`).
- Screenshot fallback ghi đè frame screencast nhỏ.
- Pin locale bị geo ghi đè.
- Nguy cơ CSRF từ website tới API localhost.
- Timeout treo ở CONNECT response và TLS handshake sau tunnel.
- Relay chỉ xử lý CONNECT làm hỏng request `http://` absolute-form.
- Tab mới bị gắn hai listener `close`/CDP do `openTab()` và sự kiện `page` cùng chạy.
- Spawn `wireproxy` lỗi (ENOENT/EACCES) làm crash server vì thiếu listener `error`.
- `shutdownAll()` không chờ `wireproxy` dừng hẳn.
- `verify:proxy` treo sau khi in OK do socket tunnel còn mở.
- Thông báo 401 trên dashboard không nói cách mở lại bằng token.

### Security

- Thêm `VB_TOKEN`, CSRF guard, DNS-rebinding Host check, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`.
- Giới hạn path xoá profile trong `PROFILES_DIR`.
- Không đưa proxy credential vào Chrome command line.

### Known limitations

- Chưa spoof canvas/audio/fonts/geolocation/media devices.
- `navigator.plugins` là object giả, chưa phải `PluginArray`.
- Chưa có import backup, test unit/CI.
- Session runtime không persist qua restart server.

---

## [0.1.0] — 2026-10-27

### Added

- Khung dự án: `types`, `config`, `store` JSON atomic.
- Fingerprint generator cơ bản (UA, locale, timezone, screen, WebGL).
- Playwright persistent context.
- Dò Chrome/wireproxy.
- Dashboard ban đầu.
