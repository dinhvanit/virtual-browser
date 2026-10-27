# Kiến trúc

Tài liệu này mô tả **cách hệ thống chạy**, không chỉ file nào làm gì. Đọc kèm
[NETWORK](NETWORK.md) và [FINGERPRINT](FINGERPRINT.md).

---

## 1. Mục tiêu thiết kế

1. **Cô lập thật**: mỗi profile có Chrome `user-data-dir` riêng. Không dùng chung cookie,
   cache, localStorage, extension.
2. **Đường ra đúng**: mọi request của profile đi qua proxy/VPN đã cấu hình; IP dùng để tra
   geo cũng phải đi qua đúng đường đó.
3. **Nhất quán**: UA, client hints, platform, locale, timezone, screen, WebGL, hardware
   không được mâu thuẫn nhau. Timezone/locale phải khớp IP thoát.
4. **Quan sát được**: nhìn thấy browser đang chạy, tab, URL, ảnh live, lỗi mạng.
5. **Local-first**: không cloud, không telemetry, dữ liệu nằm trong `data/`.

---

## 2. Bản đồ module

| File | Trách nhiệm |
| --- | --- |
| `src/config.ts` | đường dẫn, dò Chrome/wireproxy, env, timeout, version |
| `src/types.ts` | toàn bộ contract dữ liệu dùng chung |
| `src/store.ts` | đọc/ghi `profiles.json` atomic, tạo/xoá user-data-dir an toàn |
| `src/util/random.ts` | hash FNV-1a, PRNG mulberry32, seed picker, id |
| `src/lib/fingerprint.ts` | sinh fingerprint từ seed, apply geo, init script, UA metadata |
| `src/lib/geo-locale.ts` | map country → locale/timezone, canonical timezone, validate IANA |
| `src/lib/socks5.ts` | SOCKS5 client handshake (no-auth + username/password) |
| `src/lib/upstream.ts` | mở tunnel tới target qua direct/HTTP/HTTPS/SOCKS5; HTTP GET qua proxy |
| `src/lib/relay.ts` | HTTP forward proxy local, chuyển tiếp CONNECT + absolute-form request |
| `src/lib/geo.ts` | tra IP/geo qua đúng proxy, fallback 2 provider, `checkProxy` |
| `src/lib/vpn.ts` | spawn/stop `wireproxy`, parse `[Socks5] BindAddress`, chờ port |
| `src/runtime.ts` | session map, launch/stop, Playwright context, screencast, tab, navigate |
| `src/server/index.ts` | Fastify, static UI, auth token, error handler, graceful shutdown |
| `src/server/routes/*.ts` | REST endpoints theo nhóm |
| `src/server/validate.ts` | validate input, `HttpError` |
| `public/*` | dashboard vanilla JS (không build step) |
| `scripts/verify-*.ts` | kiểm chứng fingerprint và proxy stack |

Luồng phụ thuộc (mũi tên = import):

```text
server ─► runtime ─► fingerprint ─► geo-locale
   │          │            │
   │          ├─► relay ───┴─► upstream ─► socks5
   │          ├─► geo ───────► upstream
   │          ├─► vpn
   │          └─► store
   └─► validate / routes
```

Không có vòng import. `runtime.ts` chỉ import `store` (không ngược lại).

---

## 3. Data model

### 3.1 `Profile`

```jsonc
{
  "id": "164684c1-...",              // UUID, cũng là seed fingerprint ban đầu
  "name": "Shopee seller — US",
  "notes": "2FA ở điện thoại A",
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
  "fingerprint": { "...": "xem dưới" },
  "geo": { "...": "xem GeoInfo" },
  "geoError": "ipwho.is returned HTTP 502 | ...",
  "lastLaunchedAt": "2026-10-27T15:58:44.010Z",
  "lastCheck": { "ok": true, "checkedAt": "...", "latencyMs": 263, "geo": { } }
}
```

- `proxy` và `vpn` độc lập về dữ liệu, nhưng **VPN thắng** khi launch (xem §5).
- `geo` là kết quả lần kiểm tra gần nhất; có thể cũ hơn IP hiện tại nếu proxy xoay IP.
- `lastCheck` giữ cả trường hợp fail (`ok: false`, `error`).

### 3.2 `Fingerprint`

```jsonc
{
  "osProfile": "windows",            // native | windows | macos
  "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/150.0.7871.186 ...",
  "chromeVersion": "150.0.7871.186", // lấy từ Chrome thật
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
  "localePinned": false,             // true = không cho geo ghi đè locale
  "timezonePinned": false
}
```

`osProfile: "native"` nghĩa là **không giả OS**: UA/platform lấy theo host, không patch
WebGL/hardware (tránh lộ hardware thật bị bịa sai). `windows`/`macos` patch toàn bộ.

### 3.3 `GeoInfo`

`ip, country, countryCode, region, city, timezone, isp, org, checkedAt, provider,
latencyMs`. Provider hiện tại: `ipwho.is`, fallback `ipapi.co`.

### 3.4 `RuntimeStatus` (không persist)

`state: stopped | starting | running | error`, `startedAt`, `error`, `url`, `title`,
`tabs[]`, `streaming`, `proxyServer`, `vpnActive`.

Server restart → session map rỗng → mọi profile hiện `stopped` dù Chrome cũ có còn sống
hay không. Đây là chủ ý: không có process supervisor.

---

## 4. Luồng tạo profile

```text
POST /api/profiles
  ├─ validate name/url/proxy/vpn/locale/timezone
  ├─ id = uuid
  ├─ fingerprint = generateFingerprint({ seed: id, osProfile, locale?, timezone? })
  ├─ mark localePinned/timezonePinned nếu client gửi giá trị cụ thể
  ├─ userDataDir = data/profiles/<id>/user-data
  └─ addProfile() → ghi JSON atomic
```

Chưa launch thì chưa tạo thư mục user-data (Playwright tự tạo). Chưa check IP thì `geo`
rỗng; dashboard hiện “IP not checked yet”.

Nhân bản profile: id mới, seed mới, copy proxy/VPN/tags/notes, **không** copy user-data.

---

## 5. Luồng launch (quan trọng nhất)

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
    alt có VPN
        RT->>NET: startVpn() → wireproxy
        NET-->>RT: SOCKS5 port 127.0.0.1:P
        Note over RT: browser proxy = socks5://127.0.0.1:P
    else có proxy
        RT->>NET: startRelay(proxy)
        NET-->>RT: http://127.0.0.1:Q (không auth)
        Note over RT: browser proxy = relay URL
    else direct
        Note over RT: không proxy
    end
    RT->>GEO: lookupGeo(đúng proxy của profile)
    GEO-->>RT: ip/country/timezone (+ latency)
    RT->>RT: profile.fingerprint = applyGeo(fp, geo)
    RT->>CH: launchPersistentContext(userDataDir, options)
    RT->>CH: addInitScript(fingerprintInitScript)
    RT->>CH: CDP Emulation.setUserAgentOverride (từng page)
    RT->>CH: goto(startUrl)
    RT->>CH: Page.startScreencast + fallback screenshot
    RT->>RT: state = running, save lastLaunchedAt
    RT-->>API: RuntimeStatus
```

### 5.1 Thứ tự ưu tiên mạng

1. `profile.vpn` (WireGuard) — nếu có, dùng SOCKS5 local của wireproxy.
2. `profile.proxy` — nếu có, dựng relay local.
3. Direct.

Proxy **không được chain** sau VPN. Muốn chain phải tự thay đổi thiết kế; hiện tại
VPN là lớp mạng cuối.

### 5.2 Geo refresh

- Có proxy/VPN: **luôn** tra lại lúc launch (IP có thể đã xoay).
- Direct: dùng lại `geo` nếu `checkedAt` < 24h, tránh chậm/không cần thiết.
- Lỗi geo **không chặn launch**. `geoError` được lưu; browser vẫn mở với fingerprint cũ.
- Nếu `localePinned`/`timezonePinned` = true, `applyGeo` giữ giá trị người dùng chọn.

### 5.3 Playwright context options

```ts
executablePath: CHROME_PATH
headless: HEADLESS
args: [--no-first-run, --disable-blink-features=AutomationControlled,
       --force-webrtc-ip-handling-policy=disable_non_proxied_udp (khi có proxy),
       --lang=..., --window-size=...]
ignoreDefaultArgs: ["--enable-automation"]
userAgent, locale, timezoneId, viewport, screen, deviceScaleFactor, colorScheme
extraHTTPHeaders: { "Accept-Language": ... }
proxy: { server: relayOrSocks }
```

Chrome thật + `playwright-core` (không tải Chromium) để giữ codec, brand “Google Chrome”,
TLS/JA3 thật.

### 5.4 Chống lộ WebRTC

Khi có proxy/VPN, thêm
`--force-webrtc-ip-handling-policy=disable_non_proxied_udp` để WebRTC không dùng UDP trực
tiếp từ interface thật. Đây là biện pháp **giảm thiểu**, không phải chứng minh không leak
tuyệt đối; xem [NETWORK §7](NETWORK.md#7-webrtc-và-dns-leak).

---

## 6. Relay local — vì sao cần?

Chrome nhận proxy qua `--proxy-server`/Playwright `proxy.server`. Chrome **không gửi**
username/password từ URL kiểu `http://user:pass@host:port` một cách ổn định, nhất là
SOCKS5. Vì vậy:

```text
Chrome ──► 127.0.0.1:Q (relay, không auth)
              │  CONNECT host:port   (hoặc GET absolute-form)
              ▼
        connectUpstream(profile.proxy)
              ├─ http/https: TCP/TLS tới proxy + CONNECT + Proxy-Authorization
              └─ socks5: greeting → auth → CONNECT domain/IP
              ▼
        target
```

Relay hỗ trợ:

- `CONNECT host:port` — dùng cho HTTPS và (với Chrome) cả phần lớn request.
- absolute-form `GET http://...` — viết lại thành origin-form trước khi đẩy vào tunnel.
- loại bỏ `Proxy-Connection`, `Proxy-Authorization` khỏi request của Chrome.
- giới hạn header 64 KB, timeout socket 120 s, đóng cả hai đầu khi một đầu chết.

Relay bind `127.0.0.1` với port ngẫu nhiên. Không có auth vì chỉ phục vụ Chrome local;
đóng khi profile stop.

Chi tiết + test: [NETWORK](NETWORK.md).

---

## 7. Vòng đời session trong runtime

```text
stopped ──launch──► starting ──ok──► running
                        │               │
                        └──error──► error ──launch lại──► starting
                                        │
running ──context.close()/stop──► stopped (xoá session)
error   ──dispose──► giữ entry lỗi để UI đọc; launch lần sau xoá
```

- `sessions: Map<profileId, Session>` trong RAM.
- `Session` giữ `BrowserContext`, `RelayHandle`, `vpnActive`, `activePage`, CDP screencast,
  frame JPEG gần nhất (base64), `cleaned`.
- **Single-flight**: nếu đang `starting|running`, gọi launch trả status hiện tại.
- `disposeSession()` idempotent: stop screencast → close context → close relay → stop VPN.
  `context.on("close")` cũng gọi dispose (guard `cleaned`).
- Khi tab active đóng, runtime chọn tab đầu còn lại và chuyển screencast.
- Tab được đánh index theo `context.pages()`; index có thể đổi sau khi đóng tab — UI luôn
  lấy lại danh sách sau mỗi action/poll.

### Screencast

- CDP `Page.startScreencast` (JPEG q=45, maxWidth=420, everyNthFrame=4) cho tab active.
- Mỗi frame lưu base64 + ack ngay để Chrome tiếp tục gửi.
- Nếu chưa có frame trong 400 ms (tab tĩnh/headless không hỗ trợ), fallback
  `page.screenshot(scale: "css")`.
- `GET /api/profiles/:id/thumbnail` trả frame mới nhất, `204` nếu chưa có.
- Khi đổi tab/stop, screencast cũ được stop + detach CDP.

---

## 8. API & UI

- Fastify 5, JSON, static `public/`.
- Mọi route nằm dưới `/api`; UI gọi cùng origin nên không cần CORS.
- Lỗi chuẩn hoá: `{ "error": "...", "statusCode": 400 }`.
- `VB_TOKEN` (tuỳ chọn) → hook `onRequest` chặn `/api/*` nếu thiếu `x-vb-token`.
- UI vanilla JS, không bundler: poll `/api/profiles` 3 s, thumbnail 1.8 s. Reconcile theo
  `card._sig` để không rebuild DOM khi chỉ trạng thái runtime đổi (giữ focus URL bar).
- Xem [API](API.md).

---

## 9. Lưu trữ & tính bền vững

- JSON ghi qua file tạm rồi `rename` → tránh file hỏng giữa chừng.
- Không có migration framework; `DB.version = 1`. Khi đổi schema phải:
  1. Tăng version.
  2. Viết hàm migrate trong `initStore()` (đọc → biến đổi → ghi lại).
  3. Ghi vào [CHANGELOG](CHANGELOG.md) + [PROCESS](PROCESS.md).
- `removeProfile()` chỉ xoá thư mục nếu đường dẫn resolve nằm trong `PROFILES_DIR`
  (chống path traversal).
- `profiles.json` chứa secret (proxy password). Không commit `data/` (đã có `.gitignore`).

---

## 10. Xử lý lỗi

| Tình huống | Hành vi |
| --- | --- |
| Chrome không tồn tại | launch trả 500, message rõ; `/api/system` báo `found:false` |
| Proxy sai auth | relay nhận 407 → Chrome hiện lỗi proxy; check IP trả lỗi 407 |
| Proxy treo | timeout 15 s ở `connectUpstream`, 9 s geo; launch vẫn tiếp tục |
| Geo lỗi | lưu `geoError`, launch tiếp tục |
| VPN thiếu binary/config/port | launch fail trước khi mở Chrome; wireproxy bị kill |
| Start URL lỗi | browser vẫn mở; `session.error` hiện trên card |
| Tab crash/đóng | screencast chuyển tab khác; lỗi CDP bị nuốt |
| Server SIGINT/SIGTERM | đóng Fastify → stop mọi session → stop VPN → exit |

Triết lý: **lỗi mạng/geo không được làm mất khả năng mở browser**, nhưng lỗi cấu hình
(thiếu Chrome, thiếu wireproxy) phải fail sớm và rõ.

---

## 11. Quyết định thiết kế & đánh đổi

| Quyết định | Lý do | Đánh đổi |
| --- | --- | --- |
| Chrome thật, không Chromium bundled | fingerprint thương mại, codec, TLS thật | phụ thuộc máy người dùng |
| Relay local cho mọi proxy | auth hoạt động với Chrome | thêm 1 hop TCP local |
| VPN ưu tiên hơn proxy | tránh double-hop khó hiểu | không chain được |
| Screencast thay vì VNC | không cần thêm dependency/port | chỉ thấy tab active, ≤ 420 px |
| JSON store | đơn giản, dễ backup | không phù hợp multi-process |
| Session trong RAM | không cần DB runtime | restart server mất trạng thái |
| Fingerprint sinh từ seed | tái lập được, không random mỗi launch | đổi fingerprint phải “regenerate” |
| Geo tự động | locale/timezone khớp IP | launch chậm ~0.3–2 s; cần Internet |

---

## 12. Điểm mở rộng

- **Thêm proxy type** (SSH, Tor): thêm vào `ProxyType`, `connectUpstream`, validate, UI.
- **Thêm VPN kind**: mở rộng `VpnConfig`, `vpn.ts`, nhánh `prepareNetwork`.
- **Thêm fingerprint surface** (canvas/audio/fonts): thêm field vào `Fingerprint`, patch
  trong `fingerprintInitScript`, thêm assert vào `scripts/verify-fingerprint.ts`.
- **Thêm geo provider**: thêm hàm `lookupX`, đưa vào mảng fallback trong `lookupGeo`.
- **Event realtime**: thay polling bằng SSE/WebSocket, phát sự kiện từ runtime.
