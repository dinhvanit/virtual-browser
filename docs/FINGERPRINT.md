# Fingerprint

Mục tiêu không phải “giả nhiều thứ nhất”, mà là **không mâu thuẫn**. Một profile có ít
surface nhưng nhất quán thường an toàn hơn một profile spoof 20 thứ nhưng UA nói Windows,
WebGL nói Apple M2, timezone nói Berlin và IP ở Bangkok.

---

## 1. Nguyên tắc nhất quán

| Cặp giá trị | Quy tắc |
| --- | --- |
| `userAgent` ↔ `userAgentData` ↔ Chrome binary | cùng một `chromeVersion` lấy từ Chrome thật |
| `navigator.platform` ↔ UA ↔ WebGL driver | Windows ↔ Win32 ↔ ANGLE D3D11; macOS ↔ MacIntel ↔ ANGLE Metal |
| `navigator.language/languages` ↔ `Accept-Language` ↔ context locale | cùng `locale` |
| `Intl` timezone ↔ geo IP | cùng quốc gia (trừ khi người dùng pin) |
| `screen` ↔ `window-size` ↔ viewport ↔ DPR | cùng một bộ trong `Fingerprint` |
| `hardwareConcurrency` ↔ `deviceMemory` | giá trị desktop hợp lý (8–16) |
| `navigator.webdriver` ↔ launch args | `false` + `--disable-blink-features=AutomationControlled` |
| WebGL vendor ↔ renderer | cùng cặp GPU trong preset |
| Client hints header ↔ JS `userAgentData` | CDP `Emulation.setUserAgentOverride` + init script |
| WebRTC ↔ proxy | `disable_non_proxied_udp` khi có proxy |

`generateFingerprint()` dùng **một seed duy nhất** cho mọi lựa chọn, nên các field không
thể “lệch pha” do random độc lập.

---

## 2. Seed & sinh fingerprint

```text
seed = profile.id (lúc tạo)
        │
        ▼
FNV-1a hash → mulberry32 PRNG
        │
        ├─ chọn locale/timezone preset (nếu chưa pin)
        ├─ chọn screen + deviceScaleFactor
        ├─ chọn WebGL vendor/renderer (chỉ windows/macos)
        ├─ chọn hardwareConcurrency ∈ {8,12,16}
        ├─ chọn deviceMemory ∈ {8,16}
        └─ chọn colorScheme (15% dark)
```

- Cùng seed → cùng fingerprint (tái lập được, dễ debug).
- “Regenerate fingerprint” tạo seed mới (`newId()`), nên toàn bộ lựa chọn đổi.
- Đổi `osProfile` regenerate với seed cũ + suffix OS; giữ được “cá tính” ổn định.

### Chrome version

`chromeVersion()` chạy `google-chrome --version` một lần/process và cache. UA dùng version
đầy đủ; client hints dùng major + full version. Nếu không dò được, dùng
`VB_CHROME_VERSION` hoặc fallback `150.0.0.0`.

> Sau khi update Chrome, **restart server** để version mới được dò lại.

### OS profile

| `osProfile` | Hành vi |
| --- | --- |
| `native` | UA/platform theo host; **không** patch WebGL/hardware; locale/timezone lấy hệ thống nếu chưa có geo |
| `windows` | UA Windows NT 10.0; `Win32`; patch WebGL ANGLE D3D11, hardware, client hints platform Windows |
| `macos` | UA Macintosh Intel 10_15_7; `MacIntel`; patch WebGL ANGLE Metal, hardware, client hints macOS |

Hiện preset macOS dùng Intel UA (không phải Apple Silicon UA) để khớp `platform` và WebGL
ổn định. Đây là lựa chọn có chủ ý; nếu cần Apple Silicon UA, phải thêm preset mới và sửa
`verify-fingerprint.ts`.

---

## 3. Geo → locale/timezone

`applyGeo(fingerprint, geo)`:

1. `countryCode` → locale qua bảng `src/lib/geo-locale.ts` (US→en-US, DE→de-DE, VN→vi-VN…).
2. `geo.timezone` nếu là IANA hợp lệ → canonical hoá bằng ICU
   (`Asia/Ho_Chi_Minh` → `Asia/Saigon`, `Europe/Kyiv` → `Europe/Kiev`).
3. Nếu `localePinned` → giữ locale người dùng.
4. Nếu `timezonePinned` → giữ timezone người dùng.

Canonical hoá quan trọng vì Chrome trả `Intl.DateTimeFormat().resolvedOptions().timeZone`
theo tên ICU; lưu tên khác sẽ làm metadata lệch page.

### Pin hay auto?

- **Auto** (mặc định): locale/timezone bám IP thoát. Phù hợp profile gắn với proxy cố định.
- **Pin locale**: người dùng Việt muốn UI tiếng Anh nhưng IP US vẫn hợp lý (expat).
- **Pin timezone**: ít dùng; chỉ khi cần khớp lịch làm việc.

UI: để trống = auto; nhập giá trị = pin. API: gửi `null` để bỏ pin.

---

## 4. Những gì được spoof

### 4.1 Qua Playwright context options

| Surface | Cơ chế |
| --- | --- |
| `navigator.userAgent` | `userAgent` |
| `navigator.language(s)` | `locale` |
| `Intl` timezone | `timezoneId` |
| viewport / screen / DPR | `viewport`, `screen`, `deviceScaleFactor` |
| `prefers-color-scheme` | `colorScheme` |
| `Accept-Language` header | `extraHTTPHeaders` |

### 4.2 Qua CDP (`Emulation.setUserAgentOverride`)

- `userAgent`
- `acceptLanguage`
- `platform`
- `userAgentMetadata`:
  - `brands`, `fullVersionList`, `fullVersion`
  - `platform`, `platformVersion`, `architecture`, `model`, `mobile`, `bitness`, `wow64`

Áp dụng cho từng page khi tạo và trước khi điều hướng bằng API. Page do site tự mở
(`window.open`) được patch ngay khi Playwright phát event `page`, nhưng request đầu tiên
của popup có thể đã bắt đầu — giới hạn đã biết.

### 4.3 Qua init script (mọi frame)

`fingerprintInitScript(fp)` chạy trước script của trang:

| Thuộc tính | Giá trị |
| --- | --- |
| `navigator.webdriver` | `false` |
| `navigator.platform` | `fp.platform` |
| `navigator.hardwareConcurrency` | 8/12/16 |
| `navigator.deviceMemory` | 8/16 |
| `navigator.language`, `languages` | theo locale, dạng `[locale, base]` |
| `navigator.userAgent`, `appVersion` | theo fp |
| `navigator.vendor` | `Google Inc.` |
| `navigator.userAgentData` | brands, platform, `getHighEntropyValues()` |
| `navigator.plugins`, `mimeTypes` | bộ PDF viewer desktop |
| `window.chrome.runtime` | object rỗng (giống Chrome thường) |
| WebGL `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` | theo fp (qua `getParameter` 37445/37446 và extension) |

Mọi getter dùng `Object.defineProperty` trên prototype, `configurable: true`.

### 4.4 Launch args

| Arg | Mục đích |
| --- | --- |
| `--disable-blink-features=AutomationControlled` | ẩn dấu hiệu automation của Chromium |
| `ignoreDefaultArgs: ["--enable-automation"]` | Playwright không bật automation banner |
| `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` | chặn WebRTC UDP đi thẳng khi có proxy |
| `--lang=<locale>` | ngôn ngữ UI/engine |
| `--password-store=basic` | tránh keyring prompt trên Linux |
| `--no-sandbox` | chỉ thêm trên Linux (môi trường dev/container) |

---

## 5. Kiểm chứng

```bash
npm run verify:fingerprint
```

Script:

1. Sinh fingerprint seed cố định, OS `windows`.
2. Mở Chrome headless với đúng context options + init script.
3. Đọc lại từ page: UA, webdriver, platform, languages, hardware, deviceMemory, Intl
   timezone, `userAgentData` + high entropy, `window.chrome`, screen/DPR, WebGL vendor +
   renderer (kể cả debug extension).
4. So sánh từng field; in mismatch và exit code 1 nếu lệch.

Script này là **hợp đồng** giữa code và browser. Khi thêm surface mới, thêm assert tương
ứng.

---

## 6. Giới hạn đã biết

| Surface | Trạng thái | Rủi ro |
| --- | --- | --- |
| Canvas fingerprint | Không spoof | GPU/OS thật vẫn tạo hash khác profile “cùng fingerprint” |
| WebAudio | Không spoof | hash audio |
| Fonts | Không spoof | danh sách font host có thể lộ Linux/Windows |
| TLS/JA3 | **Thật của Chrome** (tốt) | không khớp nếu profile giả OS khác host? JA3 không phụ thuộc OS nhiều |
| WebRTC | Giảm thiểu bằng policy | có thể vẫn lộ public IP nếu policy bị bỏ qua |
| Client hints của request đầu popup | Có thể lệch | page event đến sau khi request bắt đầu |
| `navigator.plugins` | Object giả, không phải `PluginArray` | JS nâng cao có thể phát hiện |
| Geolocation API | Không spoof | vị trí thật nếu user grant; Chrome sẽ prompt |
| Media devices | Không spoof | số lượng/ID thiết bị thật |
| Battery, Bluetooth, USB | Không spoof | ít dùng để fingerprint |
| DNS | Theo proxy (SOCKS5 domain / CONNECT hostname) | direct thì DNS thật |
| HTTP/2 fingerprint | Thật của Chrome | tốt |
| Timezone alias | Canonical hoá | đã xử lý |
| Screen vs cửa sổ thật | Window size có thể bị OS scale | `--window-size` + viewport |

### Khuyến nghị vận hành

- Một profile = một tài khoản = một IP ổn định. Đổi proxy liên tục làm geo/fingerprint
  nhảy múa.
- Warm-up: mở vài trang thật, cuộn/click tự nhiên trước khi làm việc chính.
- Không bật/tắt proxy giữa phiên. Stop → đổi → launch lại.
- Với `osProfile` khác host, tránh dùng tính năng native như font rendering, extension,
  WebGL app nặng; rủi ro lộ host tăng.
- Không dùng headless cho profile thật (`VB_HEADLESS=0`).

---

## 7. Thêm một surface mới (ví dụ canvas noise)

1. Thêm field vào `Fingerprint` (`canvasSeed?: string`).
2. Sinh trong `generateFingerprint` từ picker.
3. Patch trong `fingerprintInitScript` **trước** khi trang chạy; giữ tính deterministic
   theo seed (cùng profile → cùng canvas hash).
4. Thêm assert vào `scripts/verify-fingerprint.ts`.
5. Ghi vào bảng §4, §6, CHANGELOG, DEVLOG.
6. Test với ít nhất 3 seed khác nhau, đảm bảo hash ổn định trong cùng session và khác giữa
   các profile.

Tiêu chí không được phá: **không treo trang**, **không làm lệch các surface khác**, **không
tăng entropy theo hướng dễ phát hiện** (ví dụ mọi profile cùng một noise pattern).
