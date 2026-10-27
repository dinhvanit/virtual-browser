# Virtual Browser

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![Chrome](https://img.shields.io/badge/browser-real%20Chrome-4285F4.svg)](https://www.google.com/chrome/)
[![Status](https://img.shields.io/badge/status-beta-orange.svg)](docs/ROADMAP.md)

**Trình quản lý profile Chrome self-hosted, local-first: mỗi profile là một danh tính
riêng với proxy/VPN riêng và fingerprint nhất quán.**

> Self-hosted Chrome profile manager for QA, geo testing and browser automation: isolated
> profiles, per-profile proxy/VPN, coherent fingerprints, local REST API. Data never leaves
> your machine.

> **Trạng thái:** `v0.2.0` — beta, thiết kế cho máy cá nhân, bind `127.0.0.1`.
> Không thiết kế để mở ra Internet. Đọc [SECURITY](docs/SECURITY.md) trước khi đổi `VB_HOST`.

![Dashboard: live view, tabs, fingerprint và geo](docs/dashboard.png)

_Dashboard: live view qua CDP screencast, tab/URL bar, fingerprint và IP thoát của từng profile._

---

## Mục lục

- [Vì sao có dự án này](#vì-sao-có-dự-án-này)
- [Tính năng](#tính-năng)
- [Yêu cầu](#yêu-cầu)
- [Chạy nhanh](#chạy-nhanh)
- [Quy trình sử dụng](#quy-trình-sử-dụng)
- [Cấu hình](#cấu-hình)
- [Dữ liệu & bảo mật](#dữ-liệu--bảo-mật)
- [Kiến trúc](#kiến-trúc)
- [API](#api)
- [Kiểm chứng](#kiểm-chứng)
- [Giới hạn đã biết](#giới-hạn-đã-biết)
- [Khi nào nên / không nên dùng](#khi-nào-nên--không-nên-dùng)
- [Đóng góp](#đóng-góp)
- [Giấy phép](#giấy-phép)

---

## Vì sao có dự án này

Làm việc với nhiều tài khoản, nhiều vùng địa lý hoặc nhiều test case thường gặp cùng một
vấn đề: **profile trình duyệt bị lẫn dữ liệu, IP lệch vùng, và fingerprint không khớp nhau**
(UA Windows nhưng timezone Việt Nam, GPU Mac, locale sai).

Virtual Browser giải quyết bằng cách tách mỗi danh tính thành một profile Chrome độc lập:

- user-data-dir riêng (cookie, localStorage, cache không lẫn);
- proxy/VPN riêng, có thể có username/password;
- fingerprint sinh **deterministic** từ seed của profile và đồng bộ theo IP thoát;
- điều khiển qua dashboard hoặc REST API, không cần tự viết script cho từng bước.

Điểm khác biệt so với dịch vụ cloud browser: **dữ liệu và phiên nằm trên máy bạn**, phiên
được giữ lâu dài, và bạn tự chọn đường mạng.

---

## Tính năng

| Nhóm | Hiện có |
| --- | --- |
| **Profile** | tạo/sửa/xoá/nhân bản, tags, notes, start URL, user-data-dir riêng, export JSON |
| **Mạng** | HTTP/HTTPS/SOCKS5 proxy **có auth**, WireGuard qua `wireproxy`, direct |
| **Relay local** | proxy không credential cho Chrome, xử lý CONNECT + absolute-form |
| **Fingerprint** | UA + client hints theo Chrome thật, platform, locale, timezone, screen, DPR, WebGL, hardwareConcurrency, deviceMemory, color scheme, plugins, `navigator.webdriver` |
| **Đồng bộ geo** | tra IP thoát qua đúng proxy/VPN → gán locale + timezone, hiển thị country/city/ISP |
| **Pin locale/timezone** | giữ lựa chọn thủ công, không bị geo ghi đè |
| **Vận hành** | launch/stop, live thumbnail (CDP screencast), tab list, mở/đóng/chuyển tab, URL bar |
| **Kiểm tra** | test proxy/IP độc lập, check IP của profile |
| **API** | REST JSON đầy đủ, phục vụ luôn UI tĩnh |
| **Bảo mật** | `VB_TOKEN` tuỳ chọn, CSRF same-origin guard, Host/DNS-rebinding guard, security headers |

**Không phải:** trình duyệt cloud, công cụ test cross-browser (Safari/iOS/Android), hay
sandbox malware. Xem [Giới hạn](#giới-hạn-đã-biết).

---

## Yêu cầu

- **Node.js ≥ 20** (khuyến nghị 22 LTS).
- **Google Chrome / Chromium** cài trên máy. Dự án dùng Chrome thật qua `playwright-core`,
  **không tải Chromium bundled** — để UA, client hints, codec và TLS fingerprint khớp Chrome
  thật.
- (Tuỳ chọn) **wireproxy** nếu dùng WireGuard: <https://github.com/pufferffish/wireproxy>
- Linux headed cần X11/Wayland. Server/CI không màn hình dùng `VB_HEADLESS=1`.

Kiểm tra nhanh:

```bash
node -v          # >= 20
google-chrome --version
```

---

## Chạy nhanh

```bash
git clone https://github.com/dinhvanit/virtual-browser.git
cd virtual-browser
npm ci
npm start
```

Mở **http://127.0.0.1:8787**.

Dev mode (tự reload khi sửa server):

```bash
npm run dev
```

Chạy thử với dữ liệu tách riêng, không màn hình:

```bash
VB_HEADLESS=1 VB_PORT=8799 VB_DATA_DIR=/tmp/vb-dev npm start
```

Chạy có token:

```bash
VB_TOKEN=my-secret npm start
# mở: http://127.0.0.1:8787/?token=my-secret
```

Token được lưu vào `localStorage` và tự bỏ khỏi URL sau lần mở đầu.

Dừng server bằng `Ctrl+C` — Chrome, relay và VPN con sẽ được đóng theo.

---

## Quy trình sử dụng

1. **Tạo profile** — nhập tên, chọn OS profile (`native`, `windows`, `macos`), start URL,
   tags/notes.
2. **Chọn danh tính** — để trống locale/timezone nếu muốn geo tự gán; nhập nếu muốn pin.
3. **Gán mạng** — proxy HTTP/HTTPS/SOCKS5 (kèm auth) hoặc WireGuard config, hoặc để direct.
   Nếu có cả hai, **VPN được ưu tiên** và không chain proxy.
4. **Lưu → Launch** — Chrome mở với user-data-dir riêng, fingerprint và mạng đã chọn.
5. **Làm việc** — xem live view, mở/đóng/chuyển tab, nhập URL trên thanh địa chỉ.
6. **Kiểm tra** — nút *Check IP* xác nhận IP thoát thực tế của profile.
7. **Stop** — đóng Chrome và giải phóng relay/VPN; dữ liệu duyệt web vẫn còn cho lần sau.

> Session runtime chỉ nằm trong RAM. Restart server thì các profile hiện **Stopped**, nhưng
> cookie/login trong `user-data/` vẫn được giữ.

---

## Cấu hình

Tất cả qua biến môi trường (không cần file `.env`):

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `VB_HOST` | `127.0.0.1` | Địa chỉ bind. Chỉ đổi thành `0.0.0.0` khi đã bật `VB_TOKEN` + firewall. |
| `VB_PORT` | `8787` | Cổng HTTP. |
| `VB_DATA_DIR` | `./data` | Nơi lưu `profiles.json`, user-data-dir, log VPN. |
| `VB_TOKEN` | rỗng | Nếu đặt, mọi request `/api/*` cần header `x-vb-token`. |
| `VB_HEADLESS` | `0` | `1` = Chrome headless (chỉ nên dùng cho test/CI). |
| `CHROME_PATH` | tự dò | Đường dẫn Chrome/Chromium. |
| `VB_CHROME_VERSION` | tự dò | Ghi đè version dùng cho UA/client hints. |
| `VB_WIREPROXY` | tự dò | Đường dẫn binary `wireproxy`. |
| `VB_START_URL` | `https://example.com/` | Start URL mặc định cho profile mới. |
| `VB_GEO_TIMEOUT_MS` | `9000` | Timeout tra geo/IP. |
| `VB_VPN_BOOT_TIMEOUT_MS` | `10000` | Thời gian chờ wireproxy mở cổng SOCKS5. |
| `VB_LOG_LEVEL` | `info` | Mức log Fastify (`debug`, `warn`, `error`). |

Ví dụ:

```bash
VB_PORT=9000 VB_DATA_DIR=~/vb-data VB_TOKEN=... npm start
```

---

## Dữ liệu & bảo mật

```text
data/                          # VB_DATA_DIR
├── profiles.json              # metadata tất cả profile
└── profiles/
    └── <uuid>/
        └── user-data/         # Chrome user-data-dir (cookie, localStorage, cache)
```

> **Cảnh báo:** `profiles.json` lưu **mật khẩu proxy dạng plain text**. Hãy bảo vệ quyền
> đọc thư mục `data/` (`chmod 700`), không commit, không chia sẻ file này.
>
> `data/` đã nằm trong `.gitignore`. Xoá profile trong UI sẽ xoá cả `profiles/<uuid>/`.

Khuyến nghị:

- Bật `VB_TOKEN` nếu máy dùng chung hoặc có process không tin cậy.
- Giữ `VB_HOST=127.0.0.1`; không expose ra LAN/Internet.
- Backup `profiles.json` + `profiles/` nếu cần, nhưng nhớ chúng chứa secrets.
- Chỉ dùng proxy/VPN và tài khoản mà bạn sở hữu hoặc được uỷ quyền.

Chi tiết threat model: [docs/SECURITY.md](docs/SECURITY.md).

---

## Kiến trúc

```text
Browser UI (public/)
      │ fetch JSON
      ▼
Fastify API (src/server)  ── token auth, CSRF/Host guard, security headers
      │
      ├── store.ts ──────────────► data/profiles.json (atomic writes)
      │
      └── runtime.ts
             ├── fingerprint.ts ── UA/client hints/locale/timezone/WebGL/screen
             ├── relay.ts ────────► HTTP proxy local (no auth) ──► upstream có auth
             ├── vpn.ts ──────────► wireproxy ──► SOCKS5 local
             ├── geo.ts ──────────► ipwho.is / ipapi.co qua đúng đường ra
             └── playwright-core ─► Chrome thật (user-data-dir riêng)
```

Luồng launch:

1. Chuẩn bị mạng (VPN > proxy > direct). Proxy có auth đi qua relay local để Chrome không
   cần credential trên command line.
2. Tra geo qua đúng đường ra; áp locale/timezone nếu chưa pin.
3. Mở Chrome với context options + init script fingerprint.
4. Gắn CDP override cho từng tab (client hints đầy đủ).
5. Bật screencast cho thumbnail; trả trạng thái running + tabs.

Chi tiết: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/NETWORK.md](docs/NETWORK.md), [docs/FINGERPRINT.md](docs/FINGERPRINT.md).

---

## API

Base URL: `http://127.0.0.1:8787`. Nếu có `VB_TOKEN`:

```bash
curl -H "x-vb-token: $VB_TOKEN" http://127.0.0.1:8787/api/profiles
```

| Method | Endpoint | Mô tả |
| --- | --- | --- |
| GET | `/api/health` | Health check |
| GET | `/api/system` | Thông tin Chrome/wireproxy/platform/data dir |
| GET | `/api/export` | Export metadata tất cả profile |
| GET | `/api/profiles` | Danh sách profile + runtime |
| POST | `/api/profiles` | Tạo profile |
| GET/PATCH/DELETE | `/api/profiles/:id` | Đọc/sửa/xoá profile |
| POST | `/api/profiles/:id/duplicate` | Nhân bản profile |
| GET/POST | `/api/profiles/:id/fingerprint` | Đọc/tái sinh fingerprint |
| POST | `/api/profiles/:id/check` | Check IP thoát của profile |
| POST | `/api/proxy/check` | Test proxy độc lập |
| POST | `/api/profiles/:id/launch` | Launch Chrome |
| POST | `/api/profiles/:id/stop` | Stop Chrome |
| GET | `/api/profiles/:id/session` | Trạng thái + tabs + streaming |
| GET | `/api/profiles/:id/thumbnail` | Ảnh JPEG live view |
| POST | `/api/profiles/:id/navigate` | Điều hướng tab active |
| POST | `/api/profiles/:id/tabs` | Mở tab mới |
| POST | `/api/profiles/:id/tabs/:index/activate` | Chuyển tab |
| DELETE | `/api/profiles/:id/tabs/:index` | Đóng tab |

Response dạng `{ profile }`, `{ profiles }`, `{ status }`… Chi tiết đầy đủ:
[docs/API.md](docs/API.md).

---

## Kiểm chứng

```bash
npm run verify             # typecheck + proxy stack + fingerprint
npm run verify:proxy       # HTTP/SOCKS5 auth + relay (không cần Chrome)
npm run verify:fingerprint # mở Chrome, so fingerprint sinh ra với page thật
npm run verify:ui http://127.0.0.1:8787   # smoke CRUD (server phải đang chạy)
npm run verify:token                      # thông báo thiếu/sai token (server có VB_TOKEN)
npm run ui:shot http://127.0.0.1:8787 /tmp/vb.png
```

`verify:ui` và `verify:token` cần server đang chạy; `verify:token` cần `VB_TOKEN`.

---

## Giới hạn đã biết

- **Chỉ Chrome** trên OS host. Không có Safari, iOS, Android, IE hay ma trận browser/OS.
- **Không phải sandbox malware.** Profile Chrome cách ly dữ liệu nhưng dùng chung OS; đừng
  mở link/file độc hại trên máy thật.
- Fingerprint chưa spoof canvas/audio/fonts/geolocation/media devices đầy đủ; plugins là
  object giả, chưa phải `PluginArray`.
- Chưa có team/RBAC/SSO, chưa sync nhiều máy.
- Session runtime không persist qua restart server (dữ liệu duyệt web thì có).
- `wireproxy` cần cài riêng; dự án không kèm binary.
- Chưa có test unit/CI; verify scripts là smoke test end-to-end.

---

## Khi nào nên / không nên dùng

**Phù hợp:**

- QA/test website theo quốc gia, ngôn ngữ, timezone, IP.
- Tự động hoá Playwright/Puppeteer với profile sạch, có proxy, có state.
- Quản lý nhiều tài khoản **do bạn sở hữu hoặc được khách hàng uỷ quyền**, cần tách phiên.
- Nghiên cứu privacy: so sánh fingerprint, kiểm tra rò rỉ IP/WebRTC.
- Agency quản lý tài khoản client với sự đồng ý của client.

**Không phù hợp / không được dùng:**

- Tạo tài khoản giả, farm account, né ban, gian lận quảng cáo, spam.
- Vi phạm điều khoản nền tảng hoặc pháp luật.
- Mở link/file độc hại trên máy thật (hãy dùng sandbox/VM chuyên dụng).
- Test cross-browser/device thật (dùng Browserling, Sauce Labs, BrowserStack…).

Dự án không kèm proxy, VPN, tài khoản hay dữ liệu của bên thứ ba. Bạn tự chịu trách nhiệm
về cách sử dụng và tuân thủ pháp luật/ToS.

---

## Đóng góp

```bash
npm install
npm run dev
npm run verify
```

- Giữ code/API/tên biến bằng tiếng Anh; docs và UI text ưu tiên tiếng Việt.
- Thêm test/verify case khi sửa mạng hoặc fingerprint.
- Không commit `data/`, cookie, proxy credentials, log hay binary.
- Mở issue trước với thay đổi lớn.

Quy trình chi tiết: [docs/PROCESS.md](docs/PROCESS.md).

---

## Giấy phép

Copyright © 2026 **dinhvanit**.

Dự án phát hành theo **GNU Affero General Public License v3.0** — xem [LICENSE](LICENSE).

AGPL yêu cầu: nếu bạn sửa source và cung cấp nó như một dịch vụ qua mạng, bạn phải công
khai source của phiên bản đã sửa. Dùng thương mại/dual-licensing hoặc cần điều khoản riêng:
mở issue tại <https://github.com/dinhvanit/virtual-browser/issues>.

---

## Miễn trừ trách nhiệm

Phần mềm được cung cấp **"as is"**, không bảo hành. Tác giả không chịu trách nhiệm cho thiệt
hại, mất dữ liệu, vi phạm điều khoản dịch vụ hoặc hành vi pháp lý phát sinh từ việc sử dụng.
Hãy kiểm tra luật và điều khoản của nền tảng bạn dùng.
