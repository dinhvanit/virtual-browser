# Quy trình phát triển

Tài liệu này là “runbook” cho người tiếp tục phát triển Virtual Browser. Mục tiêu: mọi
thay đổi đều **kiểm chứng được**, **không phá dữ liệu người dùng**, và **tài liệu luôn
khớp code**.

---

## 0. Trước khi bắt đầu

Đọc theo thứ tự:

1. [README](../README.md) — tính năng, env, cách chạy.
2. [ARCHITECTURE](ARCHITECTURE.md) — luồng launch và vòng đời session.
3. [NETWORK](NETWORK.md) — proxy/VPN/relay.
4. [FINGERPRINT](FINGERPRINT.md) — những gì được spoof và giới hạn.
5. [API](API.md) — contract HTTP.
6. [ROADMAP](ROADMAP.md) + [DEVLOG](DEVLOG.md) — đang ở đâu, tiếp theo làm gì.

Nếu repo chưa có git:

```bash
git init
git add .
git commit -m "chore: initial import"
```

---

## 1. Chuẩn bị môi trường

```bash
node -v                 # cần >= 20, khuyến nghị 22
npm install
npm run typecheck
npm run verify:proxy    # không cần Chrome
npm run verify:fingerprint  # cần Chrome + Internet
npm start               # http://127.0.0.1:8787
# terminal khác, sau khi server chạy:
npm run verify:ui http://127.0.0.1:8787
# kiểm tra thông báo token (server phải chạy với VB_TOKEN):
VB_TOKEN=secret npm start   # cổng riêng, ví dụ VB_PORT=8812
npm run verify:token
```

Khuyến nghị tạo thư mục dữ liệu riêng cho dev, tránh lẫn với dữ liệu thật:

```bash
VB_DATA_DIR=/tmp/opencode/vb-dev VB_PORT=8787 npm run dev
```

Không có màn hình (CI/SSH):

```bash
VB_HEADLESS=1 VB_DATA_DIR=/tmp/opencode/vb-ci npm start
```

---

## 2. Vòng phát triển chuẩn

```text
(1) Chọn việc & viết mục tiêu rõ ràng
        │  “Thêm nút export profile”, “Sửa lỗi relay 407”, …
        ▼
(2) Đọc code liên quan + docs
        │  grep/đọc module, xác định contract bị ảnh hưởng
        ▼
(3) Thiết kế ngắn (5–10 dòng)
        │  input/output, file sửa, test sẽ chạy, ảnh hưởng UI/API/data
        ▼
(4) Implement theo lớp: types → lib → runtime → API → UI → docs
        ▼
(5) Verify: typecheck → verify scripts → smoke API → smoke UI
        ▼
(6) Cập nhật docs + DEVLOG + CHANGELOG (nếu user-facing)
        ▼
(7) Commit/tag theo quy ước
```

### Vì sao implement theo lớp?

- `types.ts` là contract. Sửa trước để TypeScript chỉ ra mọi nơi cần cập nhật.
- `lib/*` không import server/UI → test độc lập được.
- `runtime.ts` là nơi dễ tạo rò rỉ tài nguyên (process, socket, context). Sửa xong phải
  kiểm tra cleanup.
- API trước UI để có thể test bằng `curl`.
- Docs cuối cùng, khi hành vi đã chốt.

---

## 3. Quy ước code

### 3.1 Chung

- TypeScript strict, ESM + NodeNext: **mọi import nội bộ phải có đuôi `.js`**
  (ví dụ `import { getProfile } from "./store.js"`).
- Không dùng `any` mới. Nếu buộc phải cast, thu hẹp ngay và ghi comment lý do.
- Không thêm dependency nếu stdlib làm được. Hiện chỉ có `fastify`, `@fastify/static`,
  `playwright-core`; dev: `tsx`, `typescript`, `@types/node`.
- Mọi I/O mạng phải có timeout. Không để promise treo vô hạn.
- Mọi tài nguyên (socket, Chrome context, wireproxy, relay) phải được đóng trong
  `try/finally` hoặc cleanup idempotent.
- Log lỗi qua `req.log.error` trong route; log chẩn đoán ở lib bằng `console.warn` có
  tiền tố `[module]`.
- Không log mật khẩu proxy, token, nội dung cookie.

### 3.2 Đặt tên & cấu trúc

| Loại | Quy ước | Ví dụ |
| --- | --- | --- |
| file | kebab-case | `geo-locale.ts`, `verify-proxy.ts` |
| type/interface | PascalCase | `Profile`, `RuntimeStatus` |
| hàm | camelCase, động từ | `launchProfile`, `applyGeo` |
| hằng | UPPER_SNAKE | `GEO_TIMEOUT_MS` |
| route | danh từ số nhiều + hành động | `POST /api/profiles/:id/launch` |

### 3.3 Error handling

- Input sai → `badRequest()` trong `validate.ts` → HTTP 400.
- Không tìm thấy → `new HttpError(404, ...)`.
- Lỗi hệ thống (Chrome/proxy/VPN) → throw `Error` với message người đọc được; error
  handler trả 500.
- Message lỗi là một phần UX: nêu **cái gì** sai và **cách sửa** nếu biết
  (`wireproxy binary not found. Install it or set VB_WIREPROXY=...`).

### 3.4 Commit

Conventional Commits:

```text
feat: add profile export endpoint
fix: keep geo locale when profile locale is pinned
docs: describe relay plain-HTTP path
refactor: split runtime tab helpers
chore: bump version to 0.2.1
```

Mỗi commit phải typecheck được. Không commit `data/`, `node_modules/`, `dist/`, log.

---

## 4. Quy trình thêm một tính năng

Ví dụ: “thêm trường `colorScheme` cho form tạo profile”.

### Bước 1 — Contract

- [ ] Thêm/sửa type trong `src/types.ts`.
- [ ] Xác định field optional hay bắt buộc; có cần migrate JSON cũ không.

### Bước 2 — Logic

- [ ] Sửa lib thuần (ví dụ `fingerprint.ts`).
- [ ] Sửa `runtime.ts` nếu cần áp dụng khi launch.
- [ ] Nếu là mạng: sửa `upstream.ts`/`relay.ts`, thêm case vào `verify-proxy.ts`.
- [ ] Nếu là fingerprint: thêm assert vào `verify-fingerprint.ts`.

### Bước 3 — API

- [ ] Thêm field vào `ProfileInput` + parse trong `validate.ts`.
- [ ] Xử lý create/patch trong `routes/profiles.ts`.
- [ ] Trả field trong response (thường tự động qua spread).
- [ ] Ghi endpoint/field mới vào `docs/API.md`.

### Bước 4 — UI

- [ ] Thêm input vào `public/index.html` (dùng `name=` để `collectForm` đọc được).
- [ ] `fillForm()` set giá trị khi edit.
- [ ] `collectForm()` validate + gửi.
- [ ] Hiển thị trên card nếu cần (`buildCard` + `signature` nếu field ảnh hưởng card).
- [ ] CSS nếu layout mới.

### Bước 5 — Verify

- [ ] `npm run typecheck`
- [ ] `npm run verify` (proxy + fingerprint) nếu chạm mạng/fingerprint
- [ ] `npm run verify:ui <url>` (cần server đang chạy)
- [ ] Smoke API (mục 6)
- [ ] Smoke UI thủ công (mục 7)

### Bước 6 — Docs

- [ ] `docs/API.md` nếu contract đổi.
- [ ] `docs/ARCHITECTURE.md` nếu luồng/module đổi.
- [ ] `docs/DEVLOG.md` thêm entry ngày hôm nay.
- [ ] `docs/CHANGELOG.md` nếu user-facing.
- [ ] `docs/ROADMAP.md` đánh dấu xong.

---

## 5. Quy trình sửa bug

1. **Tái hiện** bằng lệnh/route nhỏ nhất. Ghi lại input, log, trạng thái.
2. Xác định lớp lỗi: input? mạng? Chrome? UI? dữ liệu?
3. Viết test/kiểm chứng tối thiểu:
   - lỗi proxy → thêm case vào `scripts/verify-proxy.ts`;
   - lỗi fingerprint → thêm assert vào `scripts/verify-fingerprint.ts`;
   - lỗi API → thêm lệnh curl vào mục 6 hoặc test script.
4. Sửa **nguyên nhân**, không chỉ triệu chứng.
5. Chạy lại toàn bộ verify + smoke.
6. Ghi DEVLOG: triệu chứng → nguyên nhân → cách sửa → cách tránh tái diễn.

### Các bug đã biết cần cẩn thận

| Vùng | Cạm bẫy |
| --- | --- |
| Relay | Chrome có thể gửi absolute-form thay vì CONNECT; đừng chỉ xử lý CONNECT |
| HTTP proxy auth | Chrome không gửi credential từ `--proxy-server`; phải qua relay |
| Timeout | `readUntil`/TLS handshake có thể treo nếu không có timer |
| Geo | Phải tra qua đúng proxy; tra direct sẽ ra IP thật và làm lệch timezone |
| Fingerprint | UA version phải lấy từ Chrome thật, không hard-code |
| Pin locale | Geo không được ghi đè khi `localePinned/timezonePinned` |
| Session | `context.close()` trigger `close` event → dispose phải idempotent |
| Tab index | Index đổi sau khi đóng tab; luôn trả list mới sau action |
| Screencast | Frame đầu có thể đến sau screenshot fallback → tránh ghi đè frame nhỏ bằng ảnh lớn |

---

## 6. Smoke test API (copy-paste)

Chạy server ở terminal khác:

```bash
VB_HEADLESS=1 VB_PORT=8799 VB_DATA_DIR=/tmp/opencode/vb-smoke npm start
```

Trong shell test:

```bash
B=http://127.0.0.1:8799

# 1. health + system
curl -sf $B/api/health | python3 -m json.tool
curl -sf $B/api/system | python3 -m json.tool

# 2. kiểm tra IP direct
curl -sf -X POST $B/api/proxy/check \
  -H 'content-type: application/json' -d '{"proxy":null}' | python3 -m json.tool

# 3. tạo profile
curl -sf -X POST $B/api/profiles -H 'content-type: application/json' -d '{
  "name":"Smoke test",
  "tags":["demo"],
  "osProfile":"windows",
  "startUrl":"https://example.com/"
}' > /tmp/opencode/profile.json

ID=$(python3 -c "import json;print(json.load(open('/tmp/opencode/profile.json'))['profile']['id'])")
echo "profile=$ID"

# 4. launch (có thể mất 2–15 s vì geo lookup)
time curl -sf -X POST $B/api/profiles/$ID/launch | python3 -m json.tool

# 5. thumbnail phải là JPEG
curl -sf -o /tmp/opencode/thumb.jpg $B/api/profiles/$ID/thumbnail
file /tmp/opencode/thumb.jpg

# 6. tab + navigate
curl -sf -X POST $B/api/profiles/$ID/tabs \
  -H 'content-type: application/json' -d '{"url":"https://example.org"}' | python3 -m json.tool
curl -sf -X POST $B/api/profiles/$ID/navigate \
  -H 'content-type: application/json' -d '{"url":"https://example.net"}' | python3 -m json.tool

# 7. check IP của profile (lưu geo)
curl -sf -X POST $B/api/profiles/$ID/check | python3 -m json.tool

# 8. stop + delete
curl -sf -X POST $B/api/profiles/$ID/stop | python3 -m json.tool
curl -sf -X DELETE $B/api/profiles/$ID | python3 -m json.tool
```

Kiểm tra thêm:

- `GET /api/profiles` không lộ runtime cũ sau khi stop.
- Sau khi server restart, mọi profile phải là `stopped`.
- `GET /api/export` tải được JSON, không chứa runtime.

### Test proxy thật

```bash
# HTTP proxy có auth
curl -sf -X POST $B/api/proxy/check -H 'content-type: application/json' -d '{
  "proxy":{"type":"http","host":"127.0.0.1","port":8080,"username":"u","password":"p"}
}'

# SOCKS5 có auth
curl -sf -X POST $B/api/proxy/check -H 'content-type: application/json' -d '{
  "proxy":{"type":"socks5","host":"127.0.0.1","port":1080,"username":"u","password":"p"}
}'
```

Không có proxy thật? Chạy `npm run verify:proxy` — nó tự dựng HTTP CONNECT proxy và
SOCKS5 proxy có auth trong process, kiểm tra cả sai mật khẩu.

---

## 7. Smoke test UI

Mở `http://127.0.0.1:8787` và kiểm tra checklist:

- [ ] Tạo profile “native” + để trống locale/timezone → launch → card hiện geo, locale
      theo country, thumbnail cập nhật.
- [ ] Sửa profile: đổi tên/tags → card cập nhật, không mất dữ liệu proxy.
- [ ] Sửa profile: pin locale `en-US`, launch với IP Thái Lan → locale vẫn `en-US`,
      timezone theo geo (trừ khi pin cả timezone).
- [ ] Check IP → toast có IP/country/latency; card đổi geo.
- [ ] Launch → tab bar hiện; mở tab mới; chuyển tab; đóng tab; URL bar Enter điều hướng.
- [ ] Stop → thumbnail dừng, badge Stopped, panel tab ẩn.
- [ ] Duplicate → profile mới, không dùng chung user-data.
- [ ] Regenerate fingerprint → `seed` đổi, card đổi screen/WebGL ở lần launch sau.
- [ ] Delete → confirm; thư mục `data/profiles/<id>` biến mất.
- [ ] Search/tag/os filter hoạt động; reload trang vẫn còn profile.
- [ ] Nếu đặt `VB_TOKEN`: request không token trả 401; mở `/?token=...` dùng được.
- [ ] Chrome không có → banner đỏ; wireproxy thiếu nhưng không dùng VPN → không banner.

DevTools Console không được có lỗi JS; Network không có request 500 lặp.

---

## 8. Debug

### Log

```bash
VB_LOG_LEVEL=debug npm start
```

### Chrome bị lock user-data

Chrome chỉ cho một process mỗi user-data-dir. Nếu server bị kill đột ngột:

```bash
pgrep -af 'user-data-dir=.*data/profiles'
# kill process còn sót, hoặc xoá SingletonLock trong user-data-dir nếu chắc chắn không chạy
```

### Wireproxy

- Kiểm tra config có block:

```ini
[Socks5]
BindAddress = 127.0.0.1:25344
```

- Chạy tay xem log:

```bash
wireproxy -c /path/to/wg.conf
```

- Lỗi thường gặp: thiếu `PrivateKey`, endpoint sai, `BindAddress` trùng port.

### Relay/proxy

- `npm run verify:proxy` trước khi nghi Chrome.
- 407 = sai auth; 502 = không kết nối được upstream; timeout = proxy treo.
- Relay dùng port ngẫu nhiên; log runtime trả `proxyServer` trong status.

### Fingerprint

- `npm run verify:fingerprint` phải in `OK`.
- Nếu Chrome update: xoá cache version bằng cách restart server (version dò lúc đầu),
  chạy lại verify.
- So sánh `navigator.userAgentData.getHighEntropyValues()` trong page với fingerprint.

### Geo

- Provider có thể rate-limit. `geoError` sẽ hiện; chạy Check IP lại.
- Nếu IP là datacenter, country vẫn đúng nhưng city có thể là “Ashburn”… — bình thường.

---

## 9. Migration dữ liệu

Khi đổi schema `profiles.json`:

1. Tăng `DB.version` trong `src/store.ts`.
2. Viết hàm `migrate(db)` thuần, không side effect:
   - thêm default field;
   - đổi tên field cũ;
   - bỏ field không dùng;
   - giữ nguyên id/userDataDir.
3. Gọi trong `initStore()` sau khi parse, trước khi gán `db`.
4. Ghi file migrated ngay (một lần), hoặc ghi khi save kế tiếp — nhưng phải nhất quán.
5. Test: copy một file JSON phiên bản cũ vào `VB_DATA_DIR`, khởi động, kiểm tra không mất
   profile.
6. Ghi vào CHANGELOG + PROCESS (mục này) nếu có bước thủ công.

Nguyên tắc: **không bao giờ xoá user-data-dir** trong migrate.

---

## 10. Release checklist

- [ ] `package.json` + `src/config.ts` cùng version.
- [ ] `npm run typecheck`
- [ ] `npm run verify:proxy`
- [ ] `npm run verify:fingerprint` (nếu có Chrome)
- [ ] `npm run verify:ui` trên server vừa khởi động
- [ ] `npm run verify:token` trên server có `VB_TOKEN` (cổng riêng)
- [ ] Smoke API mục 6 trên `VB_DATA_DIR` sạch.
- [ ] Smoke UI mục 7.
- [ ] `docs/CHANGELOG.md` có mục version + ngày.
- [ ] `docs/DEVLOG.md` ghi việc đã làm.
- [ ] `docs/API.md` khớp route thực tế (`grep "app\.\(get\|post\|patch\|delete\)" src/server/routes`).
- [ ] README env table khớp `src/config.ts`.
- [ ] Không có file `data/`, log, `.env` trong commit.
- [ ] Tag: `git tag v0.2.0 && git push --tags`.

---

## 11. Definition of Done

Một task chỉ “xong” khi:

1. Hành vi đúng yêu cầu, có error message rõ.
2. `npm run typecheck` sạch.
3. Verify liên quan chạy qua.
4. Smoke API/UI tương ứng đã chạy (ưu tiên script `verify:ui` cho luồng CRUD).
5. Không rò rỉ tài nguyên sau stop/delete/restart (kiểm tra process Chrome, wireproxy,
   port relay).
6. Docs + DEVLOG cập nhật.
7. Không phá dữ liệu cũ (hoặc có migration + ghi chú).

---

## 12. Backup & khôi phục

Backup:

```bash
# Dừng server trước để JSON không đổi giữa chừng
tar -czf vb-backup-$(date +%F).tar.gz data/
```

Khôi phục:

```bash
tar -xzf vb-backup-YYYY-MM-DD.tar.gz
# đảm bảo quyền đọc/ghi cho user chạy server
```

Export metadata (không kèm cookie):

```bash
curl -sf http://127.0.0.1:8787/api/export -o vb-export.json
```

Hiện **chưa có import**. Nếu cần khôi phục metadata, dừng server rồi merge thủ công vào
`data/profiles.json` (giữ `id`, đảm bảo `userDataDir` đúng). Tính năng import nằm trong
[ROADMAP](ROADMAP.md).
