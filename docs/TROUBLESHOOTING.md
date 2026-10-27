# Troubleshooting

Mỗi mục: **triệu chứng → nguyên nhân → cách xử lý**. Chạy `npm run verify` trước để loại
trừ lỗi môi trường.

---

## 1. Server

### `EADDRINUSE` khi start

Cổng 8787 đang bị chiếm.

```bash
ss -ltnp | grep 8787
# hoặc đổi cổng
VB_PORT=8790 npm start
```

### `Cannot find module ... .js`

Bạn đang chạy bằng Node thường thay vì `tsx`, hoặc build thiếu.

```bash
npm start          # dùng tsx
npm run build && node dist/server/index.js
```

Xem lại import nội bộ phải có đuôi `.js` (ESM + NodeNext).

### UI trắng / 404 file tĩnh

- Chạy server từ **thư mục gốc repo** (config dùng `process.cwd()`).
- Kiểm tra `public/index.html` tồn tại.
- `curl -i http://127.0.0.1:8787/` phải trả `200 text/html`.

### Mọi API trả 401

`VB_TOKEN` đang bật.

```bash
curl -H 'x-vb-token: <token>' http://127.0.0.1:8787/api/health
# hoặc mở UI một lần:
# http://127.0.0.1:8787/?token=<token>
```

Dashboard hiển thị toast hướng dẫn khi thiếu token hoặc token sai; token được lưu vào
`localStorage` và tự bỏ khỏi URL sau lần mở đầu. Muốn kiểm tra tự động:
`npm run verify:token` (server phải chạy với `VB_TOKEN`).

### API ghi trả 403 `cross-origin request rejected`

Bạn gọi từ JS của origin khác (ví dụ mở file HTML local, hoặc dev server khác cổng). UI
phải được mở đúng `http://127.0.0.1:8787`. Curl không gửi `Origin` nên không bị chặn.

---

## 2. Chrome không mở

### `Chrome/Chromium not found`

```bash
google-chrome --version
# nếu chỉ có chromium:
CHROME_PATH=/usr/bin/chromium npm start
```

`/api/system` cho biết path đang dùng. Trên macOS/Windows kiểm tra đường dẫn mặc định
trong `src/config.ts`.

### Chrome crash ngay khi launch

Chạy tay để xem lỗi:

```bash
google-chrome --no-sandbox --user-data-dir=/tmp/chrome-test about:blank
```

Thường gặp trên Linux server:

- thiếu thư viện (`libnss3`, `libatk`, `libgbm`): cài dependencies của Chrome.
- chạy root/container: cần `--no-sandbox` (code đã thêm trên Linux).
- thiếu `/dev/shm`: code đã thêm `--disable-dev-shm-usage`; nếu vẫn lỗi tăng shm.

### `SingletonLock` / `profile appears to be in use`

Một Chrome khác đang dùng cùng `user-data-dir` (server crash, launch trước chưa chết).

```bash
pgrep -af 'user-data-dir=.*data/profiles'
# kill đúng process, sau đó:
rm -f data/profiles/<id>/user-data/SingletonLock
```

Chỉ xoá lock khi chắc chắn không còn Chrome chạy với profile đó.

### Không thấy cửa sổ Chrome

- `VB_HEADLESS=1` đang bật → chỉ có screencast, không có cửa sổ.
- SSH không có X11 forwarding → dùng `VB_HEADLESS=1` hoặc thiết lập `DISPLAY`.
- Wayland: thử `GDK_BACKEND=x11` nếu Chrome không hiện.

---

## 3. Thumbnail / live view

### `204 No Content` hoặc ô đen

- Profile chưa `running` → 204 là đúng.
- Vừa launch, screencast chưa gửi frame → đợi 0.5–2 s.
- Tab đang ở `chrome://` hoặc trang chặn screenshot → fallback screenshot có thể fail.
- Headless cũ: screencast vẫn hoạt động; nếu không, `page.screenshot` fallback.

### Ảnh đứng yên

`Page.startScreencast` chỉ gửi frame khi có thay đổi. Trang tĩnh sẽ đứng — bình thường.
Điều hướng hoặc cuộn trong browser để cập nhật.

### Thumbnail to bất thường (2400 px)

Đó là ảnh fallback `page.screenshot` ở DPR 1.25 trước khi frame screencast đầu tiên đến.
Sau khi trang thay đổi, frame 420 px thay thế. Không ảnh hưởng chức năng.

---

## 4. Proxy

### Chrome mở nhưng mọi trang báo lỗi proxy

1. Xem card / `GET /api/profiles/:id/session` có `state: error` không.
2. `POST /api/profiles/:id/check` xem lỗi cụ thể.
3. Chạy `npm run verify:proxy` để chắc code không hỏng.
4. Kiểm tra upstream bằng curl:

```bash
curl -x http://user:pass@host:port https://ipwho.is/
curl --socks5-hostname user:pass@host:port https://ipwho.is/
```

### `407`

Sai username/password. Lưu ý password có ký tự đặc biệt vẫn được gửi nguyên (Basic base64),
không cần URL-encode trong form UI.

### `502 Upstream connection failed`

Relay không kết nối được proxy: sai host/port, firewall, proxy chết, hoặc proxy `https` có
certificate không hợp lệ. Kiểm tra bằng `openssl s_client -connect host:port`.

### Proxy đúng nhưng IP vẫn là IP thật

- Profile có VPN? VPN thắng proxy.
- Đang xem IP từ trang cache? mở tab mới/refresh cứng.
- Kiểm tra `proxyServer` trong `RuntimeStatus`: phải là `http://127.0.0.1:<port>` (relay)
  hoặc `socks5://127.0.0.1:<vpnport>`.
- Chrome extension/khác trong user-data cũ có thể override? Thử profile mới.

### Geo ra sai nước

- Proxy exit thật ở nước đó (datacenter, geo provider ước lượng).
- Provider fallback trả dữ liệu khác; xem `geo.provider`.
- Pin locale/timezone nếu cần cố định; nhưng IP vẫn là tín hiệu mạnh nhất.

---

## 5. VPN / wireproxy

### `wireproxy binary not found`

```bash
which wireproxy
# hoặc
VB_WIREPROXY=/path/to/wireproxy npm start
```

Cài: tải release từ GitHub `pufferffish/wireproxy` (hoặc build Go), đặt vào `bin/` hoặc
`/usr/local/bin`.

### `Could not find a [Socks5] BindAddress`

Thêm vào cuối file `.conf`:

```ini
[Socks5]
BindAddress = 127.0.0.1:25344
```

### `wireproxy exited before opening its port`

Xem log cuối trong message lỗi. Chạy tay:

```bash
wireproxy -c /path/to.conf
```

Thường do: private key sai, endpoint sai, `AllowedIPs` thiếu, interface không tạo được
(container thiếu `NET_ADMIN`), hoặc port bận.

### WireGuard chạy nhưng không có mạng

- `AllowedIPs = 0.0.0.0/0` để route toàn bộ.
- `DNS = 1.1.1.1` trong `[Interface]`.
- Peer chưa handshake: kiểm tra `Endpoint`, UDP 51820, firewall.
- Container: cần quyền tạo TUN (`--cap-add=NET_ADMIN --device /dev/net/tun`).

### Port VPN trùng giữa các profile

Mỗi profile dùng một file config/port riêng. Nếu dùng chung config, chạy đồng thời sẽ lỗi
`EADDRINUSE`. Sửa `BindAddress` khác nhau cho từng profile.

---

## 6. Dữ liệu & trạng thái

### Mất profile sau restart

- Kiểm tra `VB_DATA_DIR` có bị đổi không (dev dùng `/tmp/...`).
- Kiểm tra `data/profiles.json` còn tồn tại và parse được:

```bash
python3 -m json.tool data/profiles.json > /dev/null && echo ok
```

- Nếu file hỏng, khôi phục từ backup (`tar`), không tự tạo lại rỗng.

### Profile hiện `stopped` dù Chrome còn chạy

Session chỉ nằm RAM. Restart server làm mất trạng thái. Stop Chrome thủ công rồi launch
lại, hoặc kill process còn sót (xem SingletonLock).

### Xoá profile nhưng thư mục còn

`removeProfile` chỉ xoá bên trong `PROFILES_DIR` và bỏ qua lỗi quyền. Kiểm tra quyền
`data/profiles`; xoá tay nếu cần:

```bash
rm -rf data/profiles/<id>
```

### `profiles.json` bị ghi đè rỗng

Chỉ xảy ra nếu nhiều process cùng ghi. Chỉ chạy **một** server trên một `VB_DATA_DIR`.
Khôi phục backup.

---

## 7. UI

### Nút Launch quay mãi

Launch có thể mất 2–15 s (VPN + geo + Chrome). Nếu > 30 s:

- xem log server (`VB_LOG_LEVEL=debug`);
- kiểm tra Chrome còn tiến trình;
- kiểm tra proxy timeout 15 s + geo 9 s;
- gọi `curl -X POST .../launch` để xem message lỗi.

### URL bar mất focus khi đang gõ

UI tạm dừng cập nhật panel runtime khi focus nằm trong panel. Nếu vẫn bị, refresh trang và
báo bug kèm bước tái hiện.

### Tab index sai sau khi đóng tab

Index là vị trí hiện tại, không phải ID cố định. UI luôn refresh sau thao tác; nếu gọi API
tay, đọc lại `status.tabs` trước khi activate/close.

### Toast “Failed to fetch”

Server chết hoặc đổi port. Kiểm tra tab Network; mở `http://127.0.0.1:8787/api/health`.

---

## 8. Hiệu năng

### Nhiều profile chạy → RAM cao

Mỗi Chrome thật tốn 300–800 MB. Đây là bản chất, không phải leak. Giới hạn số profile chạy
đồng thời; stop profile không dùng.

### Dashboard chậm

- Poll 3 s + thumbnail 1.8 s cho mỗi profile chạy. 10 profile = 10 ảnh/1.8 s.
- Giảm bằng cách stop bớt hoặc sửa interval trong `public/app.js`.
- Screencast đã giới hạn 420 px, q=45.

### Server log quá nhiều

```bash
VB_LOG_LEVEL=warn npm start
```

---

## 9. Thu thập thông tin khi báo lỗi

```bash
node -v
npm ls --depth=0
google-chrome --version
curl -s http://127.0.0.1:8787/api/system
VB_LOG_LEVEL=debug npm start   # lấy log quanh thời điểm lỗi
```

Không gửi kèm: cookie, `profiles.json` đầy đủ, mật khẩu proxy, private key, ảnh thumbnail
nhạy cảm.
