# Network: proxy, VPN, relay, DNS, WebRTC

This document explains **where a Chrome request goes** and why the code is more complex
than "passing a proxy URL to Chrome".

---

## 1. Overview diagram

```text
                        ┌──────────────────────────── profile ─────────────────────────────┐
                        │                                                                  │
 Chrome (user-data A)   │  --proxy-server=http://127.0.0.1:Q                               │
        │               │                                                                  │
        ▼               │                                                                  │
  relay (Q, no auth) ───┤── CONNECT / absolute-form                                        │
        │               │                                                                  │
        ▼               │                                                                  │
 connectUpstream(profile.proxy)                                                            │
        │               │                                                                  │
        ├─ http  ───────┘  TCP → CONNECT host:port → Proxy-Authorization: Basic …          │
        │                                                                                  │
        ├─ https ──────────  TLS → CONNECT host:port → Proxy-Authorization: Basic …        │
        │                                                                                  │
        └─ socks5 ─────────  TCP → greeting → user/pass → CONNECT host:port (domain)       │
                                                                                           │
                        └──────────────────────────────────────────────────────────────────┘

 VPN mode:
 Chrome → socks5://127.0.0.1:P (wireproxy) → WireGuard peer → Internet
```

- `Q` is a random port the relay requests from the OS and binds to `127.0.0.1`.
- Each running profile has its own relay (when using a proxy) or uses wireproxy's SOCKS5
  directly (when using VPN).
- There is no global proxy for the server; the server only uses the network for geo lookups.

---

## 2. Proxy

### 2.1 Supported types

| Type | Connection to proxy | Auth | Notes |
| --- | --- | --- | --- |
| `http` | TCP | Basic (CONNECT) | most common |
| `https` | TLS to proxy | Basic (CONNECT) | proxy requires TLS, certificate must be valid |
| `socks5` | TCP | RFC 1929 (user/pass) | remote DNS (sends domain) |

The port must be 1–65535. The host must not include a scheme. SOCKS4 and SOCKS5 UDP
ASSOCIATE are not supported.

### 2.2 Why a local relay?

Chrome does **not** reliably handle credentials embedded in `--proxy-server`
(`http://user:pass@host:port`), especially with SOCKS5. Other approaches (extension, policy)
are either heavy or unstable. The relay solves this:

1. Chrome only sees the proxy `http://127.0.0.1:Q` — no auth required.
2. The relay opens a tunnel to the upstream and attaches `Proxy-Authorization` or SOCKS5
   auth itself.
3. Credentials never appear in Chrome's command line (avoiding exposure via `ps`).
4. The relay can add timeouts, header limits, and clear error logs.

Trade-off: one extra loopback TCP hop (negligible) and one process/port per running
profile.

### 2.3 Two request forms the relay must handle

1. **CONNECT** (HTTPS, WebSocket wss, most requests):

```http
CONNECT example.com:443 HTTP/1.1
Host: example.com:443
```

Relay → `connectUpstream` → returns `HTTP/1.1 200 Connection Established` → bidirectional
pipe.

2. **Absolute-form** (plain HTTP):

```http
GET http://example.com/path?q=1 HTTP/1.1
Host: example.com
```

The relay opens a TCP tunnel to `example.com:80`, rewrites the request as
`GET /path?q=1 HTTP/1.1`, drops `Proxy-Connection` and `Proxy-Authorization`, then pipes.
This lets Chrome use keep-alive/bodies normally over the tunnel.

### 2.4 SOCKS5 handshake (summary)

```text
client → [05, nmethods, methods...]
server → [05, chosen]
if chosen = 02:
  client → [01, ulen, user, plen, pass]
  server → [01, status]
client → [05, 01, 00, ATYP, addr, port]
server → [05, 00, 00, ATYP, baddr, bport]
```

`ATYP`: 01 IPv4, 03 domain, 04 IPv6. The domain is resolved by the proxy (remote DNS). The
code uses a seeded/stream reader that reads the exact number of bytes, so it never consumes
payload by mistake.

Errors are mapped to human-readable messages:

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

### 2.5 Timeouts

| Stage | Default |
| --- | --- |
| TCP to proxy | 15 s (`connectUpstream`) |
| TLS to proxy `https` | 15 s |
| CONNECT response | 15 s |
| SOCKS5 handshake | 15 s |
| TLS to target (inside `getViaProxy`) | 15 s |
| Geo lookup overall (2 providers) | 9 s (`VB_GEO_TIMEOUT_MS`) |
| Relay header wait for client | 120 s socket idle |
| Chrome navigation | 30 s |

Every timeout **destroys the socket** so no file descriptors leak.

---

## 3. VPN (WireGuard via wireproxy)

### 3.1 Config requirements

`wireproxy` reads a standard WireGuard file and opens a local SOCKS5 listener. These blocks
are required:

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

- `BindAddress` is **required**; the code parses the port from this line.
- If it is not found → launch fails with a clear message.
- The port should be fixed per profile (one port per profile) to avoid collisions.
- `DNS` should be set if you want DNS over the tunnel.

### 3.2 Lifecycle

```text
startVpn(profileId, configPath)
  ├─ if already running → return existing port
  ├─ check binary + file + BindAddress
  ├─ spawn wireproxy -c <config>
  ├─ collect stdout/stderr (last 100 lines)
  ├─ poll TCP 127.0.0.1:port every 250 ms, up to 10 s
  ├─ if process exits / times out → kill + throw (with trailing log)
  └─ store Map<profileId, {child, port, log}>

stopVpn(profileId)
  ├─ SIGTERM
  ├─ wait 2 s
  └─ SIGKILL if still alive
```

`wireproxy` is killed when:

- the profile stops;
- launch fails;
- the server receives SIGINT/SIGTERM;
- the process exits on its own (the map entry is removed via the `exit` event).

### 3.3 Precedence

If a profile has both `vpn` and `proxy`, **VPN wins**; the proxy is ignored at launch.
Reason: chaining WireGuard → proxy usually improves nothing (the proxy is still the
endpoint), and it easily causes confusion and is hard to debug. The UI shows a VPN chip; to
use the proxy, turn off the VPN.

`POST /api/profiles/:id/check` with VPN enabled: if the VPN is not running, start it
temporarily → look up geo → stop it if the profile is not running.

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

- `getViaProxy()` opens a tunnel through the correct proxy, then TLS + GET. It does **not**
  use Node's `fetch`, because fetch does not go through the hand-written tunnel.
- There is an overall deadline; the second provider is only called if at least 500 ms
  remain.
- The result is stored as `GeoInfo`, including `provider`, `latencyMs`, and `checkedAt`.
- A failed geo lookup at launch does **not** block the browser (see ARCHITECTURE §5.2).
- `POST /api/proxy/check` tests a proxy without saving; `POST /api/profiles/:id/check` saves
  geo.

Why must the lookup go through the proxy? If queried directly, the IP/geo is the host's →
timezone/locale are assigned incorrectly, and the UI shows the real IP. This is a common
security bug in inferior tools.

---

## 5. DNS

| Egress path | DNS resolver | Notes |
| --- | --- | --- |
| Direct | OS resolver | normal |
| HTTP/HTTPS proxy | proxy resolves on CONNECT | Chrome does not resolve locally |
| SOCKS5 | domain is sent in the request (ATYP=03) | remote DNS at the proxy |
| WireGuard | per `DNS=` in the config, or the OS if missing | set DNS in the config |

With SOCKS5, the code prefers to send the hostname (no pre-resolution) to avoid DNS leaks.
If the target is an IP literal, it sends the corresponding ATYP.

Leak check:

```bash
# In the profile's browser, open:
https://browserleaks.com/dns
https://browserleaks.com/webrtc
https://ipinfo.io
```

Expected: IP, DNS, and WebRTC all belong to the proxy/VPN; the real ISP IP is not visible.

---

## 6. WebRTC

Chrome can use direct UDP to obtain the public IP, bypassing an HTTP/SOCKS proxy. When a
profile has a proxy/VPN, the runtime adds:

```text
--force-webrtc-ip-handling-policy=disable_non_proxied_udp
```

Effect:

- WebRTC does not use UDP that bypasses the proxy.
- It may break WebRTC (video calls) — a deliberate trade-off.
- It does not change the IP of normal pages.

This is a **mitigation**, not an absolute guarantee. To verify:

1. Launch a profile with a proxy.
2. Open `https://browserleaks.com/webrtc`.
3. The real LAN/public IP must not appear.
4. If it does → check the Chrome version/policy, try adding
   `--webrtc-ip-handling-policy=disable_non_proxied_udp` (without `force`), or disable
   WebRTC entirely via enterprise policy.

---

## 7. Testing relay/proxy

```bash
npm run verify:proxy
```

The script sets up:

1. **HTTP CONNECT proxy with auth** — verifies that `connectUpstream` sends the correct
   Basic auth.
2. **SOCKS5 proxy with auth** — verifies the greeting, RFC1929, and CONNECT by domain.
3. **Local relay** — Chrome-facing endpoint with no auth, both CONNECT and absolute-form.
4. **Wrong password** — must result in 407 / auth failed, and must not fail open.

It uses the machine's real IP for the geo lookup, so it needs Internet. Chrome is not
required.

Test with a real proxy:

```bash
curl -X POST http://127.0.0.1:8787/api/proxy/check \
  -H 'content-type: application/json' \
  -d '{"proxy":{"type":"socks5","host":"1.2.3.4","port":1080,"username":"u","password":"p"}}'
```

---

## 8. Common errors

| Symptom | Cause | Fix |
| --- | --- | --- |
| `proxy: CONNECT rejected with HTTP 407` | wrong user/pass | check again; try `curl -x` |
| `proxy: CONNECT rejected with HTTP 403` | proxy blocks IP/port | contact the provider |
| `proxy: CONNECT timed out` | proxy hung/firewall | change endpoint, check port |
| `socks5: authentication failed` | wrong auth | as above |
| `socks5: connection refused` | proxy rejected the target | target blocked or proxy policy |
| Chrome opens but every page shows a proxy error | relay died / profile failed to start | check the `error` status and server logs |
| `wireproxy binary not found` | not installed | install it or set `VB_WIREPROXY` |
| `Could not find a [Socks5] BindAddress` | config missing the block | add the block as in §3.1 |
| `wireproxy did not open ...` | bad config / port in use / dead peer | run `wireproxy -c` manually |
| Geo shows the real IP | direct check or proxy not applied | use `/profiles/:id/check`, check `proxyServer` in the status |
| WebRTC leaks the IP | policy not applied | see §6 |

---

## 9. Network security

- The relay binds to loopback with no auth. Another process on the same machine can use the
  relay while the profile is running — accepted in the local model.
- `profiles.json` stores proxy passwords in plain text. Protect file permissions with
  `chmod 600` if needed.
- `VB_HOST=0.0.0.0` without `VB_TOKEN` = anyone on the LAN can control the browser. Don't do
  that.
- VPN configs contain a private key; do not commit them and do not share wireproxy logs.
- Never log `Proxy-Authorization` headers; the code does not.
