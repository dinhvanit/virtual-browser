# Devlog

Ghi lại **công việc thực tế**: làm gì, vì sao, kiểm chứng ra sao, còn gì treo. Mỗi entry
theo ngày; entry mới thêm lên đầu. Không thay thế CHANGELOG (dành cho người dùng).

---

## 2026-10-27 — Hardening cuối vòng 0.2.0 (lifecycle tab, VPN, token UI)

### Bối cảnh

Sau khi v0.2.0 chạy được end-to-end, rà lại các đường biên ít được chạm trong demo:
tab mở đồng thời, wireproxy chết/không spawn được, thoát server, và dashboard khi
token sai. Mục tiêu là không để lại promise treo, listener trùng hay process mồ côi.

### Vấn đề & cách sửa

1. **`attachPage()` có thể chạy hai lần cho cùng một tab.**
   `openTab()` gọi trực tiếp, đồng thời `context.on("page")` cũng bắt sự kiện mở tab,
   nên một page bị gắn 2 listener `close` và 2 CDP session.
   → Thêm `WeakMap<Page, Promise<void>>` (`pageAttachments`): lần gọi sau dùng lại promise
   đã có; listener `close` chỉ đăng ký một lần. Nếu override thất bại bất thường thì xoá
   cache để lần sau thử lại.

2. **`shutdownAll()` không chờ VPN dừng.**
   `stopAllVpn()` là fire-and-forget nên process có thể thoát khi wireproxy còn sống.
   → `stopAllVpn()` chuyển sang `async`, dùng `Promise.all(stopVpn)`; `shutdownAll()`
   `await stopAllVpn()`.

3. **Spawn wireproxy lỗi → crash server.**
   `spawn()` phát sự kiện `error` (ENOENT/EACCES) bất đồng bộ; không có listener thì Node
   ném unhandled `error`. Đồng thời `exitCode` vẫn `null` nên `waitForPort()` chỉ timeout
   chứ không báo đúng nguyên nhân.
   → Thêm `child.once("error")` lưu lỗi; `waitForPort()` nhận callback `spawnError` và ném
   ngay khi có lỗi; message cuối gộp `failed to start wireproxy: ...` + log cuối.

4. **Script verify treo sau khi in OK.**
   `verify-proxy.ts` để socket tunnel half-open, `server.close()` chờ mãi nên `npm run
   verify:proxy` không bao giờ thoát (rất dễ hiểu nhầm là treo mạng).
   → `close()` có timeout 500 ms (`timer.unref()`), và thoát tường minh `process.exit(0)`
   sau khi in OK.

5. **Dashboard báo lỗi 401 khó hiểu.**
   Trước đây chỉ hiện "Unauthorized" từ server.
   → `api()` trong `public/app.js` dịch 401 thành hướng dẫn: chưa có token thì mở
   `/?token=<VB_TOKEN>`; token sai thì nói token không hợp lệ và yêu cầu mở lại.

### Kiểm chứng

```text
$ npx tsc -p tsconfig.json --noEmit
OK

$ npx tsx scripts/verify-proxy.ts
  ok  HTTP CONNECT proxy: exit IP 183.89.9.73 (TH)
  ok  SOCKS5 proxy: exit IP 183.89.9.73 (TH)
  ok  local relay (CONNECT): exit IP 183.89.9.73
  ok  local relay (plain HTTP absolute-form)
  ok  HTTP proxy wrong password: rejected (proxy: CONNECT rejected with HTTP 407)
  ok  SOCKS5 wrong password: rejected (socks5: authentication failed)
OK: proxy stack verified.        (exit 0, không còn treo)

$ npx tsx scripts/verify-fingerprint.ts
OK: every checked value matches the generated fingerprint.

$ npx tsx scripts/verify-ui.ts http://127.0.0.1:8811
  ok  create / search / edit / duplicate / delete ...
OK: UI flow verified.

$ smoke runtime (launch → tab → thumbnail → stop)
launch: running 1 tabs streaming
thumbnail: 1745 bytes, jpeg = true
open tab: 2 tabs; active index 1
activate tab 0: 0
close tab 1: 1 tabs left
navigate: https://example.net/
still running: running streaming
stop: stopped
OK: runtime smoke verified.

$ npx tsx scripts/verify-token-ui.ts   (server VB_TOKEN=secret-token)
no token  : Máy chủ yêu cầu token. Mở dashboard bằng /?token=<VB_TOKEN> ...
bad token : Token không hợp lệ hoặc đã thay đổi. Mở lại dashboard bằng /?token=<VB_TOKEN>.
good token: http://127.0.0.1:8812/ | error toasts: []
OK: token UI messages verified.
```

### Ghi chú vận hành

- `verify:token` cần server chạy với `VB_TOKEN`; script mặc định gọi cổng `8812`
  (đổi trong `scripts/verify-token-ui.ts` nếu cần).
- `verify:proxy` giờ thoát ngay sau khi in OK — dùng được trong CI tuần tự.
- Tab dedup là theo từng `Page`; không ảnh hưởng tab mở sau khi profile đã chạy.

---

## 2026-10-27 — v0.2.0: từ skeleton → antidetect browser dùng được

### Bối cảnh

Repo khởi đầu chỉ có `types.ts`, `store.ts`, `config.ts`, `package.json`, `tsconfig`.
`package.json` khai báo Fastify + Playwright nhưng chưa có server, runtime, relay, UI hay
tài liệu. Mục tiêu phiên này: hoàn thiện một vòng chạy end-to-end có thể kiểm chứng.

### Đã làm

#### 1. Nền tảng

- Hoàn thiện `config.ts`: dò Chrome (Linux/macOS/Windows), wireproxy, env
  (`VB_DATA_DIR`, `VB_HEADLESS`, timeout geo/VPN), version `0.2.0`.
- Mở rộng `types.ts`: `ProxyCheckResult`, `TabInfo`, `RuntimeStatus` có tabs/streaming,
  fingerprint có `platform`, `seed`, `localePinned`, `timezonePinned`.
- `store.ts`: thêm `userDataDirFor()`, giữ ghi atomic và guard path traversal.
- `util/random.ts`: FNV-1a + mulberry32 + picker để fingerprint deterministic.

#### 2. Fingerprint

- `lib/fingerprint.ts`:
  - dò version Chrome thật (`--version`) để UA/client hints khớp;
  - preset screen/GPU/locale/OS;
  - `applyGeo()` đồng bộ locale/timezone theo IP, tôn trọng pin;
  - init script patch navigator (webdriver, platform, hardware, languages, UA, vendor,
    `userAgentData`, plugins, `window.chrome`) + WebGL vendor/renderer;
  - `userAgentMetadata()` cho CDP `Emulation.setUserAgentOverride`.
- `lib/geo-locale.ts`: bảng country→locale/timezone, validate IANA, canonical hoá ICU,
  `languageList`.

#### 3. Mạng

- `lib/socks5.ts`: client SOCKS5 no-auth + RFC1929, domain/IPv4/IPv6, đọc byte chính xác,
  map lỗi.
- `lib/upstream.ts`: direct/HTTP/HTTPS/SOCKS5 tunnel, Basic auth cho HTTP CONNECT, HTTP GET
  qua tunnel, decode chunked, timeout toàn bộ giai đoạn.
- `lib/relay.ts`: forward proxy local, xử lý **cả** CONNECT và absolute-form, rewrite
  header, giới hạn header/idle, dọn socket.
- `lib/geo.ts`: ipwho.is → ipapi.co fallback, deadline tổng.
- `lib/vpn.ts`: parse `[Socks5] BindAddress`, spawn wireproxy, chờ port, log ring 100 dòng,
  SIGTERM→SIGKILL.

#### 4. Runtime

- `runtime.ts`: session map, single-flight launch, prepareNetwork (VPN > proxy > direct),
  geo refresh (skip 24h nếu direct), Playwright context options, CDP UA override từng page,
  screencast + fallback, tab API, navigate, cleanup idempotent, `shutdownAll`.
- Thêm `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` khi proxied.

#### 5. API + UI

- Fastify 5, static UI, error handler chuẩn hoá, graceful SIGINT/SIGTERM.
- Routes: system/health/export; profile CRUD/duplicate/fingerprint/check/proxy-check;
  runtime launch/stop/session/thumbnail/tabs/navigate.
- Validate chặt bằng tay (`HttpError`, proxy, UUID, BCP-47, IANA, URL, tags).
- UI vanilla JS: grid card, live thumbnail (blob poll), search/filter, modal tạo/sửa, test
  proxy, check IP, duplicate, regenerate, delete confirm, tabs/URL bar, toast, system
  banner.
- Token API optional + CSRF guard same-origin + security headers.

#### 6. Kiểm chứng & tài liệu

- `scripts/verify-fingerprint.ts`: 15 assert giữa generated ↔ page thật.
- `scripts/verify-proxy.ts`: dựng HTTP CONNECT proxy có auth + SOCKS5 proxy có auth; kiểm
  tra client, relay CONNECT, relay absolute-form, sai mật khẩu.
- `scripts/verify-ui.ts`: Playwright headless chạy luồng create → search → edit →
  duplicate → delete trên dashboard, bắt console/page errors.
- `scripts/screenshot-ui.ts`: chụp dashboard để review giao diện.
- Docs: README, ARCHITECTURE, PROCESS, API, FINGERPRINT, NETWORK, SECURITY, TROUBLESHOOTING,
  ROADMAP, DEVLOG, CHANGELOG.

### Kết quả kiểm chứng

```text
$ npm run typecheck
OK

$ npm run verify:fingerprint
OK: every checked value matches the generated fingerprint.

$ npm run verify:proxy
  ok  HTTP CONNECT proxy: exit IP 183.89.9.73 (TH)
  ok  SOCKS5 proxy: exit IP 183.89.9.73 (TH)
  ok  local relay (CONNECT): exit IP 183.89.9.73
  ok  local relay (plain HTTP absolute-form)
  ok  HTTP proxy wrong password: rejected (HTTP 407)
  ok  SOCKS5 wrong password: rejected (authentication failed)
OK: proxy stack verified.

$ smoke API (VB_HEADLESS=1, data dir tạm)
launch → running, "Example Domain", thumbnail JPEG
navigate → https://httpbin.org/user-agent
open tab → 2 tabs đúng active
stop → stopped

$ npm run verify:ui http://127.0.0.1:8799
  ok  create profile
  ok  search
  ok  edit profile
  ok  duplicate profile
  ok  delete "UI smoke ... (copy)"
  ok  delete "UI smoke ..."
OK: UI flow verified.

$ UI screenshot review
2 cards, states ["Running","Stopped"], không có console error.
```

### Vấn đề phát hiện trong lúc làm & cách sửa

1. **Timezone lệch giữa metadata và page**: Chrome trả tên ICU canonical
   (`Asia/Saigon`) trong khi fingerprint lưu `Asia/Ho_Chi_Minh`.
   → Thêm `canonicalTimezone()` và dùng trong `generateFingerprint` + `applyGeo`.
   Verify fingerprint bắt được mismatch này.

2. **Ảnh thumbnail đầu tiên quá lớn**: `Promise.all([startScreencast, captureStill])` làm
   screenshot (2400 px) ghi đè frame screencast (420 px) đến sau.
   → Thêm `startView()`: start screencast, chờ tối đa 400 ms, chỉ fallback screenshot nếu
   chưa có frame. Đổi `scale: "css"` cho fallback.

3. **Pin locale bị geo ghi đè**: `applyGeo` luôn thay locale/timezone.
   → Thêm `localePinned`/`timezonePinned`; UI chỉ gửi locale/timezone khi người dùng thực
     sự nhập (hoặc xoá để bỏ pin).

4. **Nguy cơ CSRF từ website độc hại**: POST form tới localhost có thể launch/stop.
   → Hook `onRequest` chặn request ghi khác origin qua `Origin`/`Sec-Fetch-Site`.
   Bổ sung kiểm tra `Host` khi bind loopback để chặn DNS rebinding.

5. **Timeout treo**: TLS handshake sau CONNECT và CONNECT response chưa có timer.
   → Thêm `withTimeout` + destroy socket; SOCKS5 có timeout listener.

6. **Relay plain HTTP**: nếu chỉ xử lý CONNECT, Chrome request `http://` sẽ fail.
   → Parse absolute-form, rewrite origin-form, giữ body, test trong verify-proxy.

### Quyết định

- VPN **thắng** proxy; không chain.
- Geo lỗi không chặn launch.
- Session không persist; restart = stopped.
- Fingerprint deterministic theo seed; regenerate = seed mới.
- macOS preset dùng UA Intel để đồng bộ với WebGL Metal/ANGLE hiện có.

### Còn treo / biết trước

- Canvas/audio/fonts/geolocation/media devices chưa spoof.
- `navigator.plugins` là object giả, chưa phải `PluginArray` hoàn chỉnh.
- Popup do site mở có thể lệch client hints ở request đầu.
- Chưa có import/backup UI, chưa có test unit/CI.
- Chưa test với wireproxy thật trong môi trường này (không có binary/peer); phần parse
  config + lifecycle đã code, cần test tay khi có VPN.
- `--no-sandbox` tự thêm trên Linux; cân nhắc opt-in cho môi trường desktop thật.

### Việc tiếp theo

1. `POST /api/import` + backup UI (v0.3).
2. SSE thay polling.
3. Canvas/audio noise deterministic.
4. Test với một proxy HTTP auth thật + một WireGuard peer thật.
5. Unit test cho `validate.ts`, `store.ts`, `applyGeo`.
