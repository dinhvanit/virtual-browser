# Security & threat model

Virtual Browser is a **local, single-user** tool. This document states what it protects,
what it does not protect, and how to harden it.

---

## 1. Threat model

| Component | Trusted? | Assumption |
| --- | --- | --- |
| OS user currently logged in | ✅ | allowed to control the browser and read `data/` |
| Other processes under the same user | ⚠️ | can read files and use the loopback relay; not defended against |
| Malicious website opened by the user | ❌ | not allowed to call write APIs |
| Other machines on the LAN | ❌ | unreachable by default (bind 127.0.0.1) |
| Proxy/VPN provider | ❌ | sees traffic and metadata by nature |
| Internet | ❌ | does not trust the IP geo provider |

**Out of scope**: defending against malware or kernel-level attacks, forensic disk reads,
multi-tenancy, and users with root privileges.

---

## 2. Assets

| Asset | Location | Sensitivity |
| --- | --- | --- |
| Login cookies/session | `data/profiles/<id>/user-data/` | 🔴 high |
| Proxy password | `data/profiles.json` (plain text) | 🔴 high |
| WireGuard private key | `.conf` file outside the repo | 🔴 high |
| API token (`VB_TOKEN`) | env + browser localStorage | 🟠 medium |
| Profile metadata | `profiles.json` | 🟡 low–medium |
| Thumbnail images | RAM, never written to disk | 🟠 (may contain sensitive content) |
| Backup archive | user-chosen location | 🔴 high (cookies + proxy passwords) |
| wireproxy logs | RAM (100 lines per profile) | 🟡 |

---

## 3. Existing controls

### 3.1 Network

- Default bind `127.0.0.1` — not exposed to the LAN.
- Local relay binds to loopback on a random port and is closed on stop.
- Chrome never receives proxy credentials via command line (avoids leaking them through
  `ps`); credentials stay in the server's RAM.
- `connectUpstream` always times out and destroys the socket on error.
- `ignoreHTTPSErrors` is not enabled — invalid certificates are still blocked.
- `disable_non_proxied_udp` when a proxy is configured (reduces WebRTC leaks).

### 3.2 API

- Serves JSON + static files only; there is no endpoint to eval JS or run shell commands.
- Strict validation: UUID, port range, URL scheme, BCP-47, IANA timezone, proxy type, tag
  length, control characters.
- `removeProfile` only deletes directories inside `PROFILES_DIR` (blocks path traversal).
- `VB_TOKEN` (optional): every `/api/*` request requires `x-vb-token`, compared in
  constant time.
- **CSRF guard**: write requests must be same-origin via `Origin` or `Sec-Fetch-Site`;
  cross-site requests get 403. Curl/API clients that send neither header still work.
- **DNS rebinding guard**: when bound to loopback, the `Host` header of `/api/*` requests
  may only be `127.0.0.1`, `localhost`, or `::1`; any other domain resolving to loopback
  gets 403.
- Security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`.
- The UI stores the token in `localStorage`; a token passed in the URL is removed from the
  address bar immediately after it is read (`history.replaceState`).

### 3.3 Data

- `.gitignore` excludes `data/`, `node_modules/`, `dist/`, and logs.
- Atomic JSON writes (tmp + rename) — no file corruption on crash.
- No telemetry, and no calls to external services except the geo provider.
- Screencast frames stay in RAM only and are never written to disk.
- Full backups require every profile to be stopped; Chrome lock files are excluded.
- Restore validates archive paths/types before extraction, streams uploads to a temp file,
  rejects symlinks, unsafe hardlinks, devices, traversal and absolute paths, and never writes
  outside the staging or profile-data directories.

---

## 4. Remaining risks

| Risk | Detail | Mitigation |
| --- | --- | --- |
| Plain-text proxy password | readable if the file or a backup leaks | `chmod 700 data`, `chmod 600 data/profiles.json`, disk encryption, no backups to public cloud storage |
| Relay has no auth | processes under the same user can use it while a profile is running | accepted for local use; do not bind to the LAN; stop profiles when not in use |
| Unencrypted backup | `.tar.gz` contains cookies, logins and plaintext proxy passwords | store on encrypted media, restrict permissions, delete old copies |
| Restore from an untrusted archive | imported profile metadata/proxy settings are attacker-controlled | restore only archives you created; review VPN/proxy fields after importing |
| API unauthenticated by default | websites can attempt calls, but the CSRF guard blocks writes; responses to GET cannot be read due to CORS | enable `VB_TOKEN` if the machine has multiple users or untrusted processes |
| Token in localStorage | XSS on the UI itself (does any input render raw HTML? no) | the UI escapes every field; CSP is not enabled; keep the UI code simple |
| Sensitive thumbnails | anyone who sees the dashboard screen | lock the machine, do not share |
| WireGuard key | config file outside the repo | 600 permissions, never commit |
| Geo provider sees the IP | inherent to the lookup | use a trusted provider; self-hosting is possible |
| Chrome 0-day | inherent to browsing the web | update Chrome |
| Fingerprint is not perfect | see FINGERPRINT §6 | warm-up, one account per profile |

### On CSRF

Modern browsers send `Origin` on every POST (including cross-site forms). The current guard
blocks the common case. If you find a bypass, enable `VB_TOKEN` — every request without a
token then gets 401 before the CSRF check even runs.

### On the token in the URL

`/?token=...` is convenient for first use, but the token may remain in history before it is
removed. For sensitive environments, send the token through a header using an API client,
or open the UI and then set `localStorage.vb_token` in DevTools.

---

## 5. Hardening checklist

- [ ] `data/` permissions `700`, `profiles.json` permissions `600`.
- [ ] Full-disk encryption enabled.
- [ ] `VB_TOKEN` set if the machine is shared or runs untrusted processes.
- [ ] Do not change `VB_HOST` to `0.0.0.0` unless a reverse proxy + auth + firewall are in place.
- [ ] Update Chrome regularly; restart the server after updating.
- [ ] Do not commit `data/`, `.conf`, or `.env`.
- [ ] Encrypted backups; never upload backups to public services.
- [ ] Stop profiles before a full backup; verify a test restore on a throwaway `VB_DATA_DIR`.
- [ ] Delete old, unused profiles (removes both cookies and metadata).
- [ ] Check `browserleaks.com/webrtc` after changing proxy/VPN.
- [ ] Rotate the proxy password/WireGuard key regularly and whenever exposure is suspected.

---

## 6. If you suspect data exposure

1. **Stop the server** (Ctrl+C) — closes Chrome/relay/VPN.
2. **Rotate** the proxy password and WireGuard key with the provider.
3. **Delete** the affected profile in the UI (removes user-data), or delete `data/profiles/<id>`.
4. Check `profiles.json` for unexpected entries.
5. If the API token leaked: change `VB_TOKEN` and restart; clear `localStorage.vb_token` in
   the browser. The dashboard will report an invalid token — reopen with `/?token=<new_VB_TOKEN>`.
6. Review shell/history logs for unexpected commands.
7. If you suspect malware: do not just delete the profile — reinstall the machine/disk.

---

## 7. Reporting vulnerabilities

Please use GitHub's private vulnerability reporting:
<https://github.com/dinhvanit/virtual-browser/security/advisories/new>. Do **not** include
real credentials, cookies, or IPs in a public issue. See the root
[SECURITY.md](../SECURITY.md) for scope, response times, and safe harbor.
