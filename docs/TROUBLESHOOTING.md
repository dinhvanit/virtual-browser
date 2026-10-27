# Troubleshooting

Each entry follows **symptom → cause → fix**. Run `npm run verify` first to rule out
environment issues.

---

## 1. Server

### `EADDRINUSE` on start

Port 8787 is already in use.

```bash
ss -ltnp | grep 8787
# or change the port
VB_PORT=8790 npm start
```

### `Cannot find module ... .js`

You are running plain Node instead of `tsx`, or the build is incomplete.

```bash
npm start          # uses tsx
npm run build && node dist/server/index.js
```

Also check that internal imports carry the `.js` extension (ESM + NodeNext).

### Blank UI / 404 on static files

- Run the server from the **repo root** (the config uses `process.cwd()`).
- Verify that `public/index.html` exists.
- `curl -i http://127.0.0.1:8787/` must return `200 text/html`.

### Every API call returns 401

`VB_TOKEN` is enabled.

```bash
curl -H 'x-vb-token: <token>' http://127.0.0.1:8787/api/health
# or open the UI once:
# http://127.0.0.1:8787/?token=<token>
```

The dashboard shows a guidance toast when the token is missing or wrong; the token is
stored in `localStorage` and automatically removed from the URL after the first open. To
check automatically: `npm run verify:token` (the server must be running with `VB_TOKEN`).

### Write API returns 403 `cross-origin request rejected`

You are calling from JS on a different origin (for example, opening a local HTML file, or a
dev server on another port). The UI must be opened at exactly
`http://127.0.0.1:8787`. Curl does not send `Origin`, so it is not blocked.

---

## 2. Chrome does not open

### `Chrome/Chromium not found`

```bash
google-chrome --version
# if only chromium is available:
CHROME_PATH=/usr/bin/chromium npm start
```

`/api/system` shows the path in use. On macOS/Windows, check the default paths in
`src/config.ts`.

### Chrome crashes immediately on launch

Run it manually to see the error:

```bash
google-chrome --no-sandbox --user-data-dir=/tmp/chrome-test about:blank
```

Common on Linux servers:

- missing libraries (`libnss3`, `libatk`, `libgbm`): install Chrome's dependencies.
- running as root/in a container: requires `--no-sandbox` (the code already adds it on Linux).
- missing `/dev/shm`: the code already adds `--disable-dev-shm-usage`; if it still fails, increase shm.

### `SingletonLock` / `profile appears to be in use`

Another Chrome instance is using the same `user-data-dir` (server crash, or a previous
launch that has not exited).

```bash
pgrep -af 'user-data-dir=.*data/profiles'
# kill the correct process, then:
rm -f data/profiles/<id>/user-data/SingletonLock
```

Only delete the lock when you are certain no Chrome instance is still running with that
profile.

### No Chrome window appears

- `VB_HEADLESS=1` is enabled → only the screencast is available, there is no window.
- SSH without X11 forwarding → use `VB_HEADLESS=1` or set `DISPLAY`.
- Wayland: try `GDK_BACKEND=x11` if Chrome does not appear.

---

## 3. Thumbnail / live view

### `204 No Content` or a black tile

- The profile is not `running` → 204 is correct.
- Just launched, the screencast has not sent a frame yet → wait 0.5–2 s.
- The tab is on `chrome://` or a page that blocks screenshots → the screenshot fallback may fail.
- Old headless: the screencast still works; if it does not, use the `page.screenshot` fallback.

### The image is frozen

`Page.startScreencast` only sends frames when something changes. Static pages stay
frozen — that is normal. Navigate or scroll in the browser to update it.

### Abnormally large thumbnail (2400 px)

That is the `page.screenshot` fallback at DPR 1.25 before the first screencast frame
arrives. Once the page changes, a 420 px frame replaces it. No functional impact.

---

## 4. Proxy

### Chrome opens but every page reports a proxy error

1. Check whether the card / `GET /api/profiles/:id/session` shows `state: error`.
2. Run `POST /api/profiles/:id/check` to see the specific error.
3. Run `npm run verify:proxy` to confirm the code is not broken.
4. Test the upstream with curl:

```bash
curl -x http://user:pass@host:port https://ipwho.is/
curl --socks5-hostname user:pass@host:port https://ipwho.is/
```

### `407`

Wrong username/password. Note that passwords containing special characters are still sent
as-is (Basic base64); no URL-encoding is needed in the UI form.

### `502 Upstream connection failed`

The relay cannot reach the proxy: wrong host/port, firewall, proxy down, or an `https` proxy
with an invalid certificate. Check with `openssl s_client -connect host:port`.

### Proxy is correct but the IP is still the real IP

- Does the profile use a VPN? The VPN takes precedence over the proxy.
- Looking at a cached IP page? Open a new tab or hard-refresh.
- Check `proxyServer` in `RuntimeStatus`: it must be `http://127.0.0.1:<port>` (relay) or
  `socks5://127.0.0.1:<vpnport>`.
- Could a Chrome extension or something else in an old user-data directory override it? Try
  a new profile.

### Geo resolves to the wrong country

- The proxy exit really is in that country (datacenter, geo provider estimate).
- The fallback provider returned different data; check `geo.provider`.
- Pin locale/timezone if you need consistency; however, the IP remains the strongest signal.

---

## 5. VPN / wireproxy

### `wireproxy binary not found`

```bash
which wireproxy
# or
VB_WIREPROXY=/path/to/wireproxy npm start
```

Install: download a release from GitHub `pufferffish/wireproxy` (or build it with Go), place
it in `bin/` or `/usr/local/bin`.

### `Could not find a [Socks5] BindAddress`

Add this to the end of the `.conf` file:

```ini
[Socks5]
BindAddress = 127.0.0.1:25344
```

### `wireproxy exited before opening its port`

Check the last log lines in the error message. Run it manually:

```bash
wireproxy -c /path/to.conf
```

Usually caused by: wrong private key, wrong endpoint, missing `AllowedIPs`, failure to
create the interface (container missing `NET_ADMIN`), or a busy port.

### WireGuard runs but there is no network

- `AllowedIPs = 0.0.0.0/0` to route all traffic.
- `DNS = 1.1.1.1` in `[Interface]`.
- The peer has not handshaked: check `Endpoint`, UDP 51820, firewall.
- Container: needs permission to create a TUN device (`--cap-add=NET_ADMIN --device /dev/net/tun`).

### VPN port collides between profiles

Each profile uses its own config file/port. Sharing a config causes `EADDRINUSE` when
running concurrently. Set a different `BindAddress` for each profile.

---

## 6. Data & state

### Profiles disappear after a restart

- Check whether `VB_DATA_DIR` changed (dev uses `/tmp/...`).
- Check that `data/profiles.json` still exists and parses:

```bash
python3 -m json.tool data/profiles.json > /dev/null && echo ok
```

- If the file is corrupt, restore from backup (`tar`); do not recreate it empty.

### Profile shows `stopped` even though Chrome is still running

Sessions live only in RAM. Restarting the server loses the state. Stop Chrome manually and
launch again, or kill the leftover process (see SingletonLock).

### Profile deleted but the directory remains

`removeProfile` only deletes inside `PROFILES_DIR` and ignores permission errors. Check the
permissions on `data/profiles`; delete manually if needed:

```bash
rm -rf data/profiles/<id>
```

### `profiles.json` overwritten with an empty file

This only happens when multiple processes write at the same time. Run only **one** server
per `VB_DATA_DIR`. Restore from backup.

### Backup returns 409

At least one profile session exists (running or starting). Stop the listed profiles and
retry. This guarantees Chrome's SQLite/cookie files are not copied mid-write.

### Restore rejects an archive (`400`)

The backup must contain `profiles.json` at the root and only `profiles/<uuid>/...` entries.
The server rejects absolute paths, `..`, backslashes, symlinks, unsafe hardlink targets,
devices, unknown roots, archives over `VB_MAX_BACKUP_MB` and more than
`VB_MAX_BACKUP_ENTRIES` entries. Use
an archive created by **Backup all data**; do not re-tar a directory with a different root
layout.

```bash
tar tzf backup.tar.gz | head
# expected:
# profiles.json
# profiles/<uuid>/user-data/...
```

### Restore returns `413 Request Entity Too Large`

The compressed archive or its declared uncompressed size exceeds the limits. Raise
`VB_MAX_BACKUP_MB` (and restart), or split/clean the profile data before backing up.

### Import says `imported: 0` with skipped entries

Each profile is validated independently. The `skipped[].reason` field names the bad field
(for example `startUrl must use http or https`). Fix the source export or edit the profile
after import. A missing VPN config path is only a warning; the profile imports and launch
fails until the path is fixed.

---

## 7. UI

### Launch button spins forever

Launch can take 2–15 s (VPN + geo + Chrome). If it takes > 30 s:

- check the server logs (`VB_LOG_LEVEL=debug`);
- check that Chrome is still running;
- check the proxy timeout of 15 s + geo 9 s;
- call `curl -X POST .../launch` to see the error message.

### URL bar loses focus while typing

The UI pauses runtime panel updates while focus is inside the panel. If it still happens,
refresh the page and report a bug with reproduction steps.

### Tab index is wrong after closing a tab

The index is the current position, not a fixed ID. The UI always refreshes after an action;
if calling the API manually, re-read `status.tabs` before activate/close.

### Toast "Failed to fetch"

The server is down or the port changed. Check the Network tab; open
`http://127.0.0.1:8787/api/health`.

---

## 8. Performance

### Many profiles running → high RAM

Each real Chrome instance uses 300–800 MB. This is inherent, not a leak. Limit the number of
concurrently running profiles; stop profiles you are not using.

### Dashboard is slow

- Polling every 3 s + thumbnails every 1.8 s per running profile. 10 profiles = 10 images/1.8 s.
- Reduce it by stopping some profiles or changing the interval in `public/app.js`.
- Screencast is already capped at 420 px, q=45.

### Too many server logs

```bash
VB_LOG_LEVEL=warn npm start
```

---

## 9. Collecting information when reporting a bug

```bash
node -v
npm ls --depth=0
google-chrome --version
curl -s http://127.0.0.1:8787/api/system
VB_LOG_LEVEL=debug npm start   # capture logs around the time of the error
```

Do not include: cookies, the full `profiles.json`, proxy passwords, private keys, or
sensitive thumbnail images.
