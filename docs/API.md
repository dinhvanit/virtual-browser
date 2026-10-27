# API reference

Base URL: `http://127.0.0.1:8787`

- Tất cả endpoint dữ liệu nằm dưới `/api`.
- Request/response là JSON (`content-type: application/json`), trừ thumbnail.
- Nếu server đặt `VB_TOKEN`, thêm header:

```http
x-vb-token: <token>
```

- Lỗi:

```json
{ "error": "profile is not running", "statusCode": 400 }
```

| Mã | Khi nào |
| --- | --- |
| 200 | OK |
| 201 | Tạo mới (profile, duplicate) |
| 204 | Thumbnail chưa có frame |
| 400 | Input sai / thao tác không hợp lệ (tab index, URL thiếu…) |
| 401 | Thiếu/sai `x-vb-token` |
| 404 | Không có profile/route |
| 500 | Lỗi Chrome, proxy, VPN, hệ thống |

`id` là UUID. Index tab là **vị trí hiện tại** trong `context.pages()`; luôn đọc lại
`status.tabs` sau mỗi thao tác.

---

## 1. System

### `GET /api/health`

```json
{
  "ok": true,
  "version": "0.2.0",
  "uptimeSec": 42,
  "profiles": 3
}
```

### `GET /api/system`

```json
{
  "version": "0.2.0",
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

Tải JSON metadata tất cả profile (không có runtime, không có cookie):

```json
{
  "format": "virtual-browser/export",
  "version": 1,
  "exportedAt": "2026-10-27T16:00:00.000Z",
  "appVersion": "0.2.0",
  "profiles": [/* Profile[] */]
}
```

Header `Content-Disposition: attachment; filename="virtual-browser-YYYY-MM-DD.json"`.

---

## 2. Profiles

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
      "fingerprint": { "...": "effective fingerprint (geo đã áp)" },
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

Lưu ý: `fingerprint` trong response là **effective** (đã `applyGeo`), có thể khác
`fingerprint` gốc trong file JSON. `fingerprintSeed` là seed gốc.

### `GET /api/profiles/:id`

```json
{ "profile": { /* như trên, không runtime */ }, "runtime": { /* RuntimeStatus */ } }
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

| Field | Bắt buộc | Ghi chú |
| --- | --- | --- |
| `name` | ✅ | 1–80 ký tự |
| `tags` | ❌ | ≤ 20 tag, mỗi tag ≤ 32 ký tự, tự dedupe |
| `notes` | ❌ | ≤ 8000 ký tự, `null` để xoá |
| `startUrl` | ❌ | mặc định `VB_START_URL`, phải là `http(s)://` hoặc `about:blank` |
| `osProfile` | ❌ | `native` (default) / `windows` / `macos` |
| `locale` | ❌ | BCP-47, ví dụ `en-US`; bỏ trống/`null` = tự suy từ geo |
| `timezone` | ❌ | IANA, ví dụ `Asia/Tokyo`; bỏ trống/`null` = tự suy từ geo |
| `proxy` | ❌ | `null` = direct |
| `vpn` | ❌ | `null` = không VPN; `configPath` phải tồn tại |

- Gửi `locale`/`timezone` cụ thể sẽ **pin** giá trị đó (geo không ghi đè).
- Proxy port 1–65535; host không kèm scheme.
- `configPath` được resolve tuyệt đối (hỗ trợ `~/`).

Response `201`:

```json
{ "profile": { /* Profile */ } }
```

Ví dụ:

```bash
curl -X POST http://127.0.0.1:8787/api/profiles \
  -H 'content-type: application/json' \
  -d '{"name":"Demo","osProfile":"windows","startUrl":"https://example.com/"}'
```

### `PATCH /api/profiles/:id`

Cùng schema, tất cả field optional. Điểm cần biết:

- `proxy: null` / `vpn: null` để xoá cấu hình.
- `notes: null`, `tags: null` để xoá.
- `locale: null` / `timezone: null` để **bỏ pin**, quay lại auto theo geo.
- Đổi `osProfile` (hoặc locale/timezone) sẽ **regenerate fingerprint** với seed cũ.
- Đổi proxy/VPN sẽ xoá `geo`, `geoError`, `lastCheck` (vì IP thoát đã đổi).
- Thay đổi mạng/fingerprint chỉ áp dụng từ **lần launch kế tiếp**. Profile đang chạy không
  tự restart.
- Tắt VPN khi profile đang chạy sẽ stop wireproxy của profile đó; browser đang chạy vẫn
  dùng tunnel cũ cho tới khi stop.

Response:

```json
{ "profile": { /* Profile */ }, "runtime": { /* RuntimeStatus */ } }
```

### `DELETE /api/profiles/:id`

Stop browser (nếu đang chạy), xoá entry và thư mục `data/profiles/<id>/`.

```json
{ "ok": true, "id": "164684c1-..." }
```

### `POST /api/profiles/:id/duplicate`

Tạo bản copy metadata với `id` mới, seed mới, **không copy** user-data/cookie:

```json
{ "profile": { "name": "Smoke test (copy)", "...": "..." } }
```

### `POST /api/profiles/:id/fingerprint`

Regenerate fingerprint (seed mới). Body optional:

```json
{ "osProfile": "macos", "locale": "en-GB", "timezone": "Europe/London" }
```

- Không gửi `locale`/`timezone` → kế thừa + giữ trạng thái pin hiện tại.
- Gửi `null` → bỏ pin, dùng giá trị seeded/geo.

```json
{ "profile": { /* Profile */ } }
```

### `GET /api/profiles/:id/fingerprint`

```json
{
  "stored": { /* fingerprint lưu trong profiles.json */ },
  "effective": { /* sau applyGeo */ }
}
```

### `POST /api/profiles/:id/check`

Tra IP/geo qua đúng proxy/VPN của profile, lưu `geo`, `lastCheck`, `geoError`.

- Nếu có VPN và chưa chạy: tự start wireproxy, check xong tự stop (trừ khi profile đang
  chạy).
- Nếu `localePinned`/`timezonePinned` = true, fingerprint giữ nguyên phần tương ứng.

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
  "profile": { /* Profile đã cập nhật */ }
}
```

Lỗi mạng vẫn trả `200` với `check.ok = false` và `check.error`; đây là kết quả kiểm tra,
không phải lỗi request.

### `POST /api/proxy/check`

Test proxy ad-hoc, **không lưu** gì (dùng cho form tạo/sửa):

```json
{ "proxy": { "type": "http", "host": "127.0.0.1", "port": 8080, "username": "u", "password": "p" } }
```

`"proxy": null` để test direct.

```json
{ "check": { "ok": true, "latencyMs": 312, "geo": { "...": "..." } } }
```

---

## 3. Runtime

### `POST /api/profiles/:id/launch`

Mở Chrome. Nếu profile đã `starting|running`, trả trạng thái hiện tại (không mở trùng).

Có thể mất 2–15 s: khởi động VPN + geo lookup + Chrome + trang đầu.

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

Lỗi cấu hình (Chrome missing, wireproxy missing, config sai) → 500 kèm message.

### `POST /api/profiles/:id/stop`

Đóng browser, relay, VPN của profile.

```json
{ "status": { "profileId": "164684c1-...", "state": "stopped" } }
```

### `GET /api/profiles/:id/session`

```json
{ "status": { /* RuntimeStatus */ } }
```

Profile chưa chạy → `state: "stopped"`, không có `tabs`.

### `GET /api/profiles/:id/thumbnail`

- `200 image/jpeg` — frame mới nhất từ screencast (thường 420 px rộng), hoặc screenshot
  fallback.
- `204` — chưa có frame (chưa launch / vừa launch).
- `Cache-Control: no-store`.

Dùng để poll mỗi 1–2 s. Không giữ kết nối.

### `POST /api/profiles/:id/navigate`

Điều hướng tab active:

```json
{ "url": "https://example.org" }
```

- Thiếu scheme → tự thêm `https://`.
- Chấp nhận `about:blank`.
- `waitUntil: domcontentloaded`, timeout 30 s.
- Trả `{ "status": RuntimeStatus }`.

### `POST /api/profiles/:id/tabs`

Mở tab mới và chuyển sang tab đó:

```json
{ "url": "https://example.org" }
```

`url` optional (mặc định `about:blank`). Response như `navigate`.

### `POST /api/profiles/:id/tabs/:index/activate`

Chuyển tab active (index lấy từ `status.tabs`).

### `DELETE /api/profiles/:id/tabs/:index`

Đóng tab. Nếu đóng tab active, runtime tự chọn tab đầu còn lại.

---

## 4. UI tĩnh

| Route | Nội dung |
| --- | --- |
| `GET /` | `public/index.html` dashboard |
| `GET /styles.css` | CSS |
| `GET /app.js` | JS |

Không có client-side router; mọi thao tác qua `/api`.
