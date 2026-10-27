# Mạng: proxy, VPN, relay, DNS, WebRTC

Tài liệu này giải thích **một request của Chrome đi qua những đâu** và tại sao code lại
phức tạp hơn “truyền proxy URL cho Chrome”.

---

## 1. Sơ đồ tổng quát

```text
                        ┌──────────────────────────── profile ────────────────────────────┐
                        │                                                                  │
 Chrome (user-data A)   │  --proxy-server=http://127.0.0.1:Q                              │
        │               │                                                                  │
        ▼               │                                                                  │
  relay (Q, no auth) ───┤── CONNECT / absolute-form                                    │
        │               │                                                                  │
        ▼               │                                                                  │
 connectUpstream(profile.proxy)                                                          │
        │               │                                                                  │
        ├─ http  ───────┘  TCP → CONNECT host:port → Proxy-Authorization: Basic …        │
        │                                                                                  │
        ├─ https ──────────  TLS → CONNECT host:port → Proxy-Authorization: Basic …        │
        │                                                                                  │
        └─ socks5 ─────────  TCP → greeting → user/pass → CONNECT host:port (domain)      │
                                                                                           │
                        └──────────────────────────────────────────────────────────────────┘

 VPN mode:
 Chrome → socks5://127.0.0.1:P (wireproxy) → WireGuard peer → Internet
```

- `Q` là port ngẫu nhiên do relay xin từ OS, bind `127.0.0.1`.
- Mỗi profile khi chạy có relay riêng (nếu dùng proxy) hoặc dùng trực tiếp SOCKS5 của
  wireproxy (nếu dùng VPN).
- Không có proxy toàn cục cho server; server chỉ dùng mạng khi tra geo.

---

## 2. Proxy

### 2.1 Loại hỗ trợ

| Type | Kết nối tới proxy | Auth | Ghi chú |
| --- | --- | --- | --- |
| `http` | TCP | Basic (CONNECT) | phổ biến nhất |
| `https` | TLS tới proxy | Basic (CONNECT) | proxy yêu cầu TLS, certificate phải hợp lệ |
| `socks5` | TCP | RFC 1929 (user/pass) | remote DNS (gửi domain) |

Port bắt buộc 1–65535. Host không kèm scheme. Không hỗ trợ SOCKS4, SOCKS5 UDP ASSOCIATE.

### 2.2 Vì sao cần relay local?

Chrome **không** xử lý đáng tin cậy credential nhúng trong `--proxy-server`
(`http://user:pass@host:port`), đặc biệt với SOCKS5. Các cách khác (extension, policy) đều
nặng hoặc không ổn định. Relay giải quyết:

1. Chrome chỉ thấy proxy `http://127.0.0.1:Q` — không cần auth.
2. Relay mở tunnel tới upstream, tự gắn `Proxy-Authorization` hoặc SOCKS5 auth.
3. Credential không bao giờ nằm trong command line của Chrome (tránh lộ qua `ps`).
4. Relay có thể thêm timeout, giới hạn header, log lỗi rõ ràng.

Đánh đổi: thêm một hop TCP loopback (không đáng kể) và một process/port mỗi profile đang
chạy.

### 2.3 Hai dạng request relay phải xử lý

1. **CONNECT** (HTTPS, WebSocket wss, hầu hết request):

```http
CONNECT example.com:443 HTTP/1.1
Host: example.com:443
```

Relay → `connectUpstream` → trả `HTTP/1.1 200 Connection Established` → pipe hai chiều.

2. **Absolute-form** (HTTP thường):

```http
GET http://example.com/path?q=1 HTTP/1.1
Host: example.com
```

Relay mở tunnel TCP tới `example.com:80`, viết lại request thành `GET /path?q=1 HTTP/1.1`,
bỏ `Proxy-Connection` và `Proxy-Authorization`, rồi pipe. Nhờ vậy Chrome có thể dùng
keep-alive/body bình thường trên tunnel.

### 2.4 SOCKS5 handshake (tóm tắt)

```text
client → [05, nmethods, methods...]
server → [05, chosen]
nếu chosen = 02:
  client → [01, ulen, user, plen, pass]
  server → [01, status]
client → [05, 01, 00, ATYP, addr, port]
server → [05, 00, 00, ATYP, baddr, bport]
```

`ATYP`: 01 IPv4, 03 domain, 04 IPv6. Domain được proxy resolve (remote DNS). Code dùng
seed/stream reader đọc đúng số byte, không ăn nhầm payload.

Lỗi được map sang message người đọc được:

| Code | Message |
| --- | --- |
| 1 | general SOCKS server failure |
| 2 | connection not allowed by ruleset |
| 3 | network unreachable |
| 4 | host unreachable |
| 5 | connection refused |
| 6 | TTL expired |
| 7 | command not supported |
| 8 | address type not supported |

### 2.5 Timeout

| Giai đoạn | Mặc định |
| --- | --- |
| TCP tới proxy | 15 s (`connectUpstream`) |
| TLS tới proxy `https` | 15 s |
| CONNECT response | 15 s |
| SOCKS5 handshake | 15 s |
| TLS tới target (trong `getViaProxy`) | 15 s |
| Geo lookup toàn bộ (2 provider) | 9 s (`VB_GEO_TIMEOUT_MS`) |
| Relay header chờ client | 120 s socket idle |
| Chrome navigation | 30 s |

Mọi timeout đều **destroy socket** để không rò file descriptor.

---

## 3. VPN (WireGuard qua wireproxy)

### 3.1 Yêu cầu config

`wireproxy` đọc file WireGuard chuẩn và mở SOCKS5 local. Cần block:

```ini
[Interface]
PrivateKey = <base64>
Address = 10.7.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = <base64>
Endpoint = vpn.example.com:51820
AllowedIPs = 0.0.0.0/0

[Socks5]
BindAddress = 127.0.0.1:25344
```

- `BindAddress` là **bắt buộc**; code parse port từ dòng này.
- Nếu không tìm thấy → launch fail với message rõ.
- Port nên cố định theo profile (mỗi profile một port) để tránh đụng.
- `DNS` nên đặt nếu muốn DNS qua tunnel.

### 3.2 Vòng đời

```text
startVpn(profileId, configPath)
  ├─ nếu đã chạy → trả port cũ
  ├─ kiểm tra binary + file + BindAddress
  ├─ spawn wireproxy -c <config>
  ├─ gom stdout/stderr (100 dòng gần nhất)
  ├─ poll TCP 127.0.0.1:port mỗi 250 ms, tối đa 10 s
  ├─ nếu process exit / timeout → kill + throw (kèm log cuối)
  └─ lưu Map<profileId, {child, port, log}>

stopVpn(profileId)
  ├─ SIGTERM
  ├─ chờ 2 s
  └─ SIGKILL nếu chưa chết
```

`wireproxy` được kill khi:

- profile stop;
- launch lỗi;
- server nhận SIGINT/SIGTERM;
- process tự exit (map tự xoá qua event `exit`).

### 3.3 Ưu tiên

Nếu profile có cả `vpn` và `proxy`, **VPN thắng**; proxy bị bỏ qua khi launch. Lý do:
chain WireGuard → proxy thường không cải thiện gì (proxy vẫn là điểm cuối), dễ gây nhầm
lẫn và khó debug. UI hiển thị chip VPN; để dùng proxy, tắt VPN.

`POST /api/profiles/:id/check` khi có VPN: nếu VPN chưa chạy, start tạm → tra geo → stop
nếu profile không chạy.

---

## 4. Geo lookup

```text
lookupGeo(proxy, timeout)
  ├─ ipwho.is  https://ipwho.is/?fields=...
  │    (ip, country, country_code, region, city, timezone.id,
  │     connection.isp, connection.org)
  └─ fallback ipapi.co /json/
       (ip, city, region, country_name, country_code, timezone, org)
```

- `getViaProxy()` mở tunnel qua đúng proxy rồi TLS + GET. **Không** dùng `fetch` của Node
  vì fetch không đi qua tunnel tự viết.
- Có deadline tổng; provider thứ hai chỉ được gọi nếu còn ≥ 500 ms.
- Kết quả lưu `GeoInfo`, gồm `provider`, `latencyMs`, `checkedAt`.
- Launch fail geo **không** chặn browser (xem ARCHITECTURE §5.2).
- `POST /api/proxy/check` test proxy không lưu; `POST /api/profiles/:id/check` lưu geo.

Tại sao phải tra qua proxy? Nếu tra direct, IP/geo là của host → timezone/locale bị gán
sai, và UI hiển thị IP thật. Đây là lỗi bảo mật phổ biến của các tool kém.

---

## 5. DNS

| Đường ra | DNS resolver | Ghi chú |
| --- | --- | --- |
| Direct | OS resolver | bình thường |
| HTTP/HTTPS proxy | proxy resolve khi CONNECT | Chrome không resolve local |
| SOCKS5 | domain được gửi trong request (ATYP=03) | remote DNS tại proxy |
| WireGuard | theo `DNS=` trong config hoặc OS nếu thiếu | nên đặt DNS trong config |

Với SOCKS5, code ưu tiên gửi hostname (không resolve trước) để tránh DNS leak. Nếu target
là IP literal, gửi ATYP tương ứng.

Kiểm tra leak:

```bash
# Trong browser của profile, mở:
https://browserleaks.com/dns
https://browserleaks.com/webrtc
https://ipinfo.io
```

Kỳ vọng: IP, DNS, WebRTC đều thuộc proxy/VPN; không thấy IP nhà mạng thật.

---

## 6. WebRTC

Chrome có thể dùng UDP trực tiếp để lấy public IP, bỏ qua proxy HTTP/SOCKS. Khi profile
có proxy/VPN, runtime thêm:

```text
--force-webrtc-ip-handling-policy=disable_non_proxied_udp
```

Tác dụng:

- WebRTC không dùng UDP không qua proxy.
- Có thể làm WebRTC không hoạt động (video call) — đánh đổi có chủ ý.
- Không thay đổi IP của page thường.

Đây là **giảm thiểu**, không phải bảo đảm tuyệt đối. Nếu cần kiểm tra:

1. Launch profile có proxy.
2. Mở `https://browserleaks.com/webrtc`.
3. Không được thấy IP LAN/public thật.
4. Nếu thấy → kiểm tra Chrome version/policy, thử thêm
   `--webrtc-ip-handling-policy=disable_non_proxied_udp` (không có `force`) hoặc tắt
   WebRTC hoàn toàn bằng policy doanh nghiệp.

---

## 7. Kiểm thử relay/proxy

```bash
npm run verify:proxy
```

Script tự dựng:

1. **HTTP CONNECT proxy có auth** — kiểm tra `connectUpstream` gửi đúng Basic auth.
2. **SOCKS5 proxy có auth** — kiểm tra greeting, RFC1929, CONNECT domain.
3. **Relay local** — Chrome-facing endpoint không auth, cả CONNECT và absolute-form.
4. **Sai mật khẩu** — phải bị 407 / auth failed, không được fail-open.

Nó dùng IP thật của máy để tra geo, nên cần Internet. Không cần Chrome.

Test với proxy thật:

```bash
curl -X POST http://127.0.0.1:8787/api/proxy/check \
  -H 'content-type: application/json' \
  -d '{"proxy":{"type":"socks5","host":"1.2.3.4","port":1080,"username":"u","password":"p"}}'
```

---

## 8. Bảng lỗi thường gặp

| Triệu chứng | Nguyên nhân | Cách xử lý |
| --- | --- | --- |
| `proxy: CONNECT rejected with HTTP 407` | sai user/pass | kiểm tra lại; thử `curl -x` |
| `proxy: CONNECT rejected with HTTP 403` | proxy chặn IP/port | liên hệ provider |
| `proxy: CONNECT timed out` | proxy treo/firewall | đổi endpoint, kiểm tra port |
| `socks5: authentication failed` | sai auth | như trên |
| `socks5: connection refused` | proxy từ chối target | target chặn hoặc proxy policy |
| Chrome mở nhưng mọi trang lỗi proxy | relay chết / profile start lỗi | xem status `error`, log server |
| `wireproxy binary not found` | chưa cài | cài hoặc `VB_WIREPROXY` |
| `Could not find a [Socks5] BindAddress` | config thiếu block | thêm block như §3.1 |
| `wireproxy did not open ...` | config sai / port bận / peer chết | chạy `wireproxy -c` tay |
| Geo ra IP thật | check direct hoặc proxy không áp dụng | dùng `/profiles/:id/check`, kiểm tra `proxyServer` trong status |
| WebRTC lộ IP | policy không ăn | xem §6 |

---

## 9. Bảo mật mạng

- Relay bind loopback, không auth. Process khác trên cùng máy có thể dùng relay khi profile
  đang chạy — chấp nhận trong mô hình local.
- `profiles.json` lưu proxy password plain text. Bảo vệ quyền file (`chmod 600` nếu cần).
- `VB_HOST=0.0.0.0` mà không có `VB_TOKEN` = bất kỳ ai trong LAN điều khiển được browser.
  Đừng làm vậy.
- VPN config chứa private key; không commit, không chia sẻ log wireproxy.
- Không log header `Proxy-Authorization`; code không làm vậy.
