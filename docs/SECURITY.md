# Bảo mật & threat model

Virtual Browser là công cụ **local, single-user**. Tài liệu này nói rõ nó bảo vệ cái gì,
không bảo vệ cái gì, và cách hardening.

---

## 1. Threat model

| Thành phần | Tin cậy? | Giả định |
| --- | --- | --- |
| Người dùng đang đăng nhập OS | ✅ | được phép điều khiển browser và đọc `data/` |
| Process khác cùng user | ⚠️ | có thể đọc file, dùng relay loopback; không chống được |
| Website độc hại user mở | ❌ | không được phép gọi API ghi |
| Máy khác trong LAN | ❌ | mặc định không truy cập được (bind 127.0.0.1) |
| Proxy/VPN provider | ❌ | thấy traffic/metadata theo bản chất |
| Internet | ❌ | không tin IP geo provider |

**Ngoài phạm vi**: chống malware/kernel-level, chống forensic đọc ổ đĩa, multi-tenant,
chống người dùng có quyền root.

---

## 2. Tài sản

| Tài sản | Nơi lưu | Mức nhạy cảm |
| --- | --- | --- |
| Cookie/session đăng nhập | `data/profiles/<id>/user-data/` | 🔴 cao |
| Mật khẩu proxy | `data/profiles.json` (plain text) | 🔴 cao |
| WireGuard private key | file `.conf` ngoài repo | 🔴 cao |
| Token API (`VB_TOKEN`) | env + localStorage trình duyệt | 🟠 trung bình |
| Metadata profile | `profiles.json` | 🟡 thấp–trung bình |
| Ảnh thumbnail | RAM, không lưu đĩa | 🟠 (có thể chứa nội dung nhạy cảm) |
| Log wireproxy | RAM (100 dòng/profile) | 🟡 |

---

## 3. Kiểm soát đang có

### 3.1 Mạng

- Bind mặc định `127.0.0.1` — không lộ ra LAN.
- Relay local bind loopback, port ngẫu nhiên, đóng khi stop.
- Chrome không nhận credential proxy qua command line (tránh lộ `ps`); credential nằm
  trong RAM của server.
- `connectUpstream` luôn timeout và destroy socket khi lỗi.
- Không bật `ignoreHTTPSErrors` — certificate sai vẫn bị chặn.
- `disable_non_proxied_udp` khi có proxy (giảm WebRTC leak).

### 3.2 API

- Chỉ phục vụ JSON + static files, không có endpoint eval JS / chạy shell.
- Validate chặt: UUID, port range, URL scheme, BCP-47, IANA timezone, proxy type, tag
  length, control characters.
- `removeProfile` chỉ xoá thư mục nằm trong `PROFILES_DIR` (chặn path traversal).
- `VB_TOKEN` (tuỳ chọn): mọi `/api/*` yêu cầu `x-vb-token`, so sánh constant-time.
- **CSRF guard**: request ghi phải same-origin qua `Origin` hoặc `Sec-Fetch-Site`; request
  cross-site bị 403. Curl/API client không gửi hai header này vẫn dùng được.
- **DNS rebinding guard**: khi bind loopback, `Host` của request `/api/*` chỉ được là
  `127.0.0.1`, `localhost` hoặc `::1`; domain khác resolve về loopback bị 403.
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`.
- UI lưu token trong `localStorage`; token trên URL được xoá khỏi address bar ngay sau khi
  đọc (`history.replaceState`).

### 3.3 Dữ liệu

- `.gitignore` chặn `data/`, `node_modules/`, `dist/`, log.
- Ghi JSON atomic (tmp + rename) — không hỏng file khi crash.
- Không telemetry, không gọi dịch vụ ngoài trừ geo provider.
- Ảnh screencast chỉ nằm RAM, không ghi đĩa.

---

## 4. Rủi ro còn lại

| Rủi ro | Chi tiết | Giảm thiểu |
| --- | --- | --- |
| Mật khẩu proxy plain text | đọc được nếu lộ file/backup | `chmod 700 data`, `chmod 600 data/profiles.json`, mã hoá ổ đĩa, không backup lên cloud công khai |
| Relay không auth | process cùng user dùng được khi profile chạy | chấp nhận local; không bind LAN; stop profile khi không dùng |
| API không auth mặc định | website có thể thử gọi, nhưng CSRF guard chặn ghi; GET không đọc được do CORS | bật `VB_TOKEN` nếu máy có nhiều user/process lạ |
| Token trong localStorage | XSS trên chính UI (không có input render HTML thô?) | UI escape mọi field; CSP chưa bật; giữ code UI đơn giản |
| Thumbnail nhạy cảm | bất kỳ ai chụp màn hình thấy dashboard | khoá máy, không share |
| WireGuard key | file config ngoài repo | quyền 600, không commit |
| Geo provider thấy IP | bản chất lookup | dùng provider tin cậy; có thể tự host |
| Chrome 0-day | bản chất duyệt web | update Chrome |
| Fingerprint không hoàn hảo | xem FINGERPRINT §6 | warm-up, một profile một account |

### Về CSRF

Trình duyệt hiện đại gửi `Origin` cho mọi POST (kể cả form cross-site). Guard hiện tại chặn
trường hợp phổ biến. Nếu phát hiện bypass, bật `VB_TOKEN` — khi đó mọi request thiếu token
bị 401 trước cả CSRF check.

### Về token trên URL

`/?token=...` tiện cho lần đầu nhưng token có thể nằm trong history trước khi bị xoá. Với
môi trường nhạy cảm, đặt token qua header bằng API client, hoặc mở UI rồi set
`localStorage.vb_token` trong DevTools.

---

## 5. Hardening checklist

- [ ] `data/` quyền `700`, `profiles.json` quyền `600`.
- [ ] Full-disk encryption bật.
- [ ] `VB_TOKEN` đặt nếu máy dùng chung hoặc có process không tin cậy.
- [ ] Không đổi `VB_HOST` sang `0.0.0.0` trừ khi có reverse proxy + auth + firewall.
- [ ] Chrome update định kỳ; restart server sau update.
- [ ] Không commit `data/`, `.conf`, `.env`.
- [ ] Backup mã hoá; không upload backup lên dịch vụ công khai.
- [ ] Xoá profile cũ không dùng (xoá cả cookie + metadata).
- [ ] Kiểm tra `browserleaks.com/webrtc` sau khi đổi proxy/VPN.
- [ ] Rotate proxy password/WireGuard key định kỳ và khi nghi lộ.

---

## 6. Khi nghi lộ dữ liệu

1. **Dừng server** (Ctrl+C) — đóng Chrome/relay/VPN.
2. **Rotate** mật khẩu proxy và WireGuard key với provider.
3. **Xoá** profile liên quan trong UI (xoá user-data) hoặc xoá `data/profiles/<id>`.
4. Kiểm tra `profiles.json` còn entry lạ không.
5. Nếu token API lộ: đổi `VB_TOKEN`, restart; xoá `localStorage.vb_token` trên trình duyệt.
   Dashboard sẽ báo token không hợp lệ — mở lại bằng `/?token=<VB_TOKEN_mới>`.
6. Rà log shell/history xem có lệnh lạ.
7. Nếu nghi malware: không chỉ xoá profile — cài lại máy/ổ đĩa.

---

## 7. Báo cáo lỗ hổng

Đây là dự án cá nhân, không có bounty. Nếu tìm thấy lỗi bảo mật, mở issue **không kèm**
credential/cookie/IP thật, hoặc liên hệ trực tiếp chủ repo.
