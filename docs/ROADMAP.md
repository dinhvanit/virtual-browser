# Roadmap

Đánh dấu `[x]` khi đã merge + verify + docs. Không đưa việc chưa có tiêu chí nghiệm thu
vào đây.

---

## v0.1 — Nền tảng (đã xong)

- [x] Profile store JSON atomic
- [x] Types/config/dò Chrome
- [x] Fingerprint generator cơ bản
- [x] Playwright persistent context
- [x] Dashboard tối giản

## v0.2 — Antidetect khả dụng (đã xong)

### Mạng
- [x] HTTP/HTTPS/SOCKS5 proxy có auth
- [x] Relay local (CONNECT + absolute-form)
- [x] SOCKS5 client (RFC 1928 + 1929)
- [x] Timeout toàn bộ handshake + destroy socket
- [x] WireGuard qua wireproxy (spawn, parse port, stop, log)
- [x] Geo lookup qua đúng proxy/VPN, fallback 2 provider
- [x] `force-webrtc-ip-handling-policy` khi proxied
- [x] `npm run verify:proxy` (HTTP auth, SOCKS5 auth, relay, sai mật khẩu)

### Fingerprint
- [x] Seed PRNG, UI/version theo Chrome thật
- [x] UA + client hints qua CDP + init script
- [x] platform/locale/timezone/screen/DPR/WebGL/hardware/plugins/webdriver
- [x] OS profile native/windows/macos
- [x] Geo → locale/timezone canonical, pin locale/timezone
- [x] `npm run verify:fingerprint` (15 assert)

### Runtime / UI
- [x] Launch/stop single-flight, cleanup idempotent
- [x] Live screencast JPEG + fallback screenshot
- [x] Tab list/mở/đóng/chuyển, URL bar
- [x] Dashboard: search/filter, tags, geo, fingerprint facts, toast, modal
- [x] Check IP theo profile + test proxy ad-hoc
- [x] Duplicate, regenerate fingerprint, delete
- [x] Export JSON
- [x] CSRF same-origin guard, security headers, optional `VB_TOKEN`

### Vận hành
- [x] Graceful shutdown đóng Chrome/relay/VPN
- [x] API reference, architecture, process, security, troubleshooting docs
- [x] Devlog + changelog
- [x] `npm run verify:ui` (create/search/edit/duplicate/delete) + `npm run ui:shot`

---

## v0.3 — Khôi phục & dữ liệu (ưu tiên cao)

### Import / backup / restore
- [ ] `POST /api/import` nhận file export, tạo profile mới (không ghi đè id cũ).
- [ ] `GET /api/export?full=1` tuỳ chọn đóng gói cả user-data (`.tar.gz`) — có cảnh báo
      bảo mật rõ.
- [ ] Backup/restore qua UI, có xác nhận.
- [ ] **Nghiệm thu**: export 3 profile → xoá → import → metadata/proxy/fingerprint khớp;
      user-data chỉ khôi phục khi chọn full.

### Profile organization
- [ ] Group/folder (một cấp), gán qua kéo thả hoặc dropdown.
- [ ] Sort theo tên/lần chạy/trạng thái.
- [ ] Bulk actions: launch/stop/delete nhiều profile (có xác nhận).
- [ ] **Nghiệm thu**: 20 profile thao tác bulk không block UI quá 2 s (dùng optimistic +
      poll).

### Dữ liệu fingerprint
- [ ] Lưu `localePinned/timezonePinned` hiển thị rõ trên card (badge “pinned”).
- [ ] Preset fingerprint (Windows 11 + RTX, MacBook M2…) để chọn nhanh.
- [ ] Lưu lịch sử fingerprint (mỗi lần regenerate) để audit.
- [ ] **Nghiệm thu**: đổi preset không làm mất proxy/notes; lịch sử chỉ đọc.

---

## v0.4 — Fingerprint sâu hơn

- [ ] Canvas noise deterministic theo seed (2D + WebGL readPixels).
- [ ] AudioContext fingerprint (buffer noise nhẹ, không phá audio).
- [ ] Font list theo OS profile (giả `document.fonts.check` + measurement).
- [ ] Geolocation API theo geo (toạ độ + permission “prompt” giả lập).
- [ ] Media devices count/labels ổn định.
- [ ] `navigator.connection`, battery, bluetooth/USB policy.
- [ ] WebRTC test tự động (không chỉ flag).
- [ ] **Nghiệm thu**: `verify:fingerprint` mở rộng ≥ 25 assert; 3 seed cho canvas hash
      khác nhau, cùng seed hash ổn định; không làm hỏng Google Maps/YouTube.

---

## v0.5 — Vận hành quy mô nhỏ

- [ ] SSE/WebSocket đẩy trạng thái + frame thay polling (giảm request).
- [ ] Proxy pool + rotation thủ công (mỗi profile một proxy, có health check).
- [ ] Health check định kỳ (opt-in), cảnh báo proxy chết.
- [ ] Import cookie/session từ file JSON (Netscape hoặc Playwright storage state) —
      có cảnh báo rủi ro.
- [ ] Mở extension unpacked theo profile.
- [ ] Custom Chrome args per profile (whitelist).
- [ ] **Nghiệm thu**: 10 profile chạy, dashboard cập nhật < 1 s, CPU server < 5% khi idle.

---

## v0.6 — Đóng gói & chất lượng

- [ ] Test tự động cho store/validate/fingerprint (node:test hoặc vitest).
- [ ] Test API bằng `fastify.inject()`.
- [ ] CI (GitHub Actions): typecheck + verify:proxy + unit test (không cần Chrome cho PR).
- [ ] Docker image (Chrome + wireproxy + app), mount `data/`.
- [ ] `npm pack`/binary packaging (pkg/bun) — quyết định sau khi đo kích thước.
- [x] `verify:ui` cơ bản bằng Playwright (CRUD + console errors) — launch/stop đã có
      smoke API; mở rộng UI test cho launch khi có proxy ổn định.
- [ ] **Nghiệm thu**: PR đỏ nếu typecheck/test fail; image chạy được với `VB_HEADLESS=1`.

---

## v1.0 — Ổn định

- [ ] Schema migration framework (`db.version` > 1) + test migrate.
- [ ] Audit log thao tác (tạo/xoá/launch/check) có timestamp, không chứa secret.
- [ ] Backup định kỳ có mã hoá (age/gpg).
- [ ] Tài liệu “vận hành an toàn” hoàn chỉnh + threat model review.
- [ ] API versioning (`/api/v1`) hoặc cam kết backward-compatible.
- [ ] **Nghiệm thu**: nâng cấp từ v0.2 không mất profile/cookie; rollback được.

---

## Technical debt / known gaps

| Vấn đề | Tác động | Đề xuất |
| --- | --- | --- |
| Session chỉ trong RAM | restart mất trạng thái, Chrome mồ côi | process registry/supervisor (v0.6) |
| Polling 3 s | nhiều request khi nhiều profile | SSE (v0.5) |
| `plugins` là object giả | detectable bởi script nâng cao | tạo `PluginArray` giả hoàn chỉnh (v0.4) |
| Client hints popup đầu tiên | lệch header | patch sớm hơn qua CDP auto-attach |
| macOS preset dùng UA Intel | không đa dạng | thêm preset Apple Silicon |
| Không có import | khôi phục thủ công | v0.3 |
| Không có test unit | refactor rủi ro | v0.6 |
| `--no-sandbox` trên Linux | giảm cô lập process | chỉ dùng khi container; cân nhắc flag opt-in |
| Password proxy plain text | lộ nếu lộ file | mã hoá store bằng passphrase (v1.0) |
| Không giới hạn số profile chạy | cạn RAM | cảnh báo + limit cấu hình (v0.5) |

---

## Nguyên tắc ưu tiên

1. **Không mất dữ liệu người dùng** trước mọi tính năng mới.
2. **Đúng mạng** (không leak IP) trước **fingerprint đẹp**.
3. **Nhất quán** trước **nhiều surface**.
4. **Đo được** trước **tối ưu**: thêm verify/assert trước khi tối ưu cảm tính.
5. **Local-first**: không thêm cloud dependency nếu không thật cần.
