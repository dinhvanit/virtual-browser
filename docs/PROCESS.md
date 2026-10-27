# Development process

This document is the runbook for anyone continuing work on Virtual Browser. The goal: every
change is **verifiable**, **never destroys user data**, and **the docs always match
the code**.

---

## 0. Before you start

Read in this order:

1. [README](../README.md) — features, env, how to run.
2. [ARCHITECTURE](ARCHITECTURE.md) — launch flow and session lifecycle.
3. [NETWORK](NETWORK.md) — proxy/VPN/relay.
4. [FINGERPRINT](FINGERPRINT.md) — what gets spoofed and the limitations.
5. [API](API.md) — HTTP contract.
6. [ROADMAP](ROADMAP.md) + [DEVLOG](DEVLOG.md) — where we are, what comes next.

If the repo has no git yet:

```bash
git init
git add .
git commit -m "chore: initial import"
```

---

## 1. Environment setup

```bash
node -v                 # requires >= 20, 22 recommended
npm install
npm run typecheck
npm run verify:proxy    # no Chrome needed
npm run verify:fingerprint  # needs Chrome + Internet
npm start               # http://127.0.0.1:8787
# second terminal, after the server is running:
npm run verify:ui http://127.0.0.1:8787
# check token handling (server must run with VB_TOKEN):
VB_TOKEN=secret npm start   # separate port, e.g. VB_PORT=8812
npm run verify:token
```

It is recommended to create a dedicated data directory for dev, so it does not mix with real data:

```bash
VB_DATA_DIR=/tmp/opencode/vb-dev VB_PORT=8787 npm run dev
```

Headless (CI/SSH):

```bash
VB_HEADLESS=1 VB_DATA_DIR=/tmp/opencode/vb-ci npm start
```

---

## 2. Standard development loop

```text
(1) Pick the task & write clear goals
        │  "Add an export profile button", "Fix relay 407", …
        ▼
(2) Read the relevant code + docs
        │  grep/read modules, identify the affected contract
        ▼
(3) Short design (5–10 lines)
        │  input/output, files touched, tests to run, UI/API/data impact
        ▼
(4) Implement by layer: types → lib → runtime → API → UI → docs
        ▼
(5) Verify: typecheck → verify scripts → API smoke → UI smoke
        ▼
(6) Update docs + DEVLOG + CHANGELOG (if user-facing)
        ▼
(7) Commit/tag following the conventions
```

### Why implement by layer?

- `types.ts` is the contract. Change it first so TypeScript points out every place that needs updating.
- `lib/*` does not import server/UI → it can be tested independently.
- `runtime.ts` is where resource leaks (processes, sockets, contexts) are most likely. After changing it,
  check cleanup.
- API before UI so you can test with `curl`.
- Docs last, once behavior is settled.

---

## 3. Code conventions

### 3.1 General

- TypeScript strict, ESM + NodeNext: **every internal import must end in `.js`**
  (for example `import { getProfile } from "./store.js"`).
- No new `any`. If a cast is unavoidable, narrow it immediately and comment why.
- Do not add a dependency if the stdlib can do the job. Currently only `fastify`, `@fastify/static`,
  `playwright-core`; dev: `tsx`, `typescript`, `@types/node`.
- Every network I/O must have a timeout. Never leave a promise hanging forever.
- Every resource (socket, Chrome context, wireproxy, relay) must be closed in
  `try/finally` or through idempotent cleanup.
- Log errors via `req.log.error` in routes; log diagnostics in lib with `console.warn` prefixed
  with `[module]`.
- Never log proxy passwords, tokens, or cookie contents.

### 3.2 Naming & structure

| Kind | Convention | Example |
| --- | --- | --- |
| file | kebab-case | `geo-locale.ts`, `verify-proxy.ts` |
| type/interface | PascalCase | `Profile`, `RuntimeStatus` |
| function | camelCase, verb | `launchProfile`, `applyGeo` |
| constant | UPPER_SNAKE | `GEO_TIMEOUT_MS` |
| route | plural noun + action | `POST /api/profiles/:id/launch` |

### 3.3 Error handling

- Bad input → `badRequest()` in `validate.ts` → HTTP 400.
- Not found → `new HttpError(404, ...)`.
- System errors (Chrome/proxy/VPN) → throw an `Error` with a human-readable message; the error
  handler returns 500.
- Error messages are part of the UX: state **what** is wrong and **how to fix it** when known
  (`wireproxy binary not found. Install it or set VB_WIREPROXY=...`).

### 3.4 Commits

Conventional Commits:

```text
feat: add profile export endpoint
fix: keep geo locale when profile locale is pinned
docs: describe relay plain-HTTP path
refactor: split runtime tab helpers
chore: bump version to 0.2.1
```

Every commit must typecheck. Do not commit `data/`, `node_modules/`, `dist/`, or logs.

---

## 4. Process for adding a feature

Example: "add a `colorScheme` field to the profile create form".

### Step 1 — Contract

- [ ] Add/change the type in `src/types.ts`.
- [ ] Decide whether the field is optional or required; decide whether old JSON needs migration.

### Step 2 — Logic

- [ ] Change the pure lib (for example `fingerprint.ts`).
- [ ] Change `runtime.ts` if the value must be applied at launch.
- [ ] If it is network-related: change `upstream.ts`/`relay.ts` and add a case to `verify-proxy.ts`.
- [ ] If it is fingerprint-related: add an assertion to `verify-fingerprint.ts`.

### Step 3 — API

- [ ] Add the field to `ProfileInput` + parse it in `validate.ts`.
- [ ] Handle create/patch in `routes/profiles.ts`.
- [ ] Return the field in the response (usually automatic via spread).
- [ ] Document the new endpoint/field in `docs/API.md`.

### Step 4 — UI

- [ ] Add the input to `public/index.html` (use `name=` so `collectForm` can read it).
- [ ] `fillForm()` sets the value when editing.
- [ ] `collectForm()` validates + submits.
- [ ] Display it on the card if needed (`buildCard` + `signature` if the field affects the card).
- [ ] CSS if the layout is new.

### Step 5 — Verify

- [ ] `npm run typecheck`
- [ ] `npm run verify` (proxy + fingerprint) if the change touches networking/fingerprint
- [ ] `npm run verify:ui <url>` (server must be running)
- [ ] API smoke (section 6)
- [ ] Manual UI smoke (section 7)

### Step 6 — Docs

- [ ] `docs/API.md` if the contract changed.
- [ ] `docs/ARCHITECTURE.md` if the flow/modules changed.
- [ ] `docs/DEVLOG.md` add today's entry.
- [ ] `docs/CHANGELOG.md` if user-facing.
- [ ] `docs/ROADMAP.md` mark it done.

---

## 5. Bug-fix process

1. **Reproduce** with the smallest command/route. Record the input, logs, and state.
2. Identify the failing layer: input? network? Chrome? UI? data?
3. Write a minimal test/verification:
   - proxy bug → add a case to `scripts/verify-proxy.ts`;
   - fingerprint bug → add an assertion to `scripts/verify-fingerprint.ts`;
   - API bug → add a curl command to section 6 or to a test script.
4. Fix the **cause**, not just the symptom.
5. Run the full verify + smoke suite again.
6. Write a DEVLOG entry: symptom → cause → fix → how to prevent a regression.

### Known bugs to watch out for

| Area | Pitfall |
| --- | --- |
| Relay | Chrome may send absolute-form instead of CONNECT; do not handle CONNECT only |
| HTTP proxy auth | Chrome does not send credentials from `--proxy-server`; it must go through the relay |
| Timeout | `readUntil`/the TLS handshake can hang without a timer |
| Geo | Must query through the right proxy; a direct query returns the real IP and skews the timezone |
| Fingerprint | The UA version must come from the real Chrome, never hard-coded |
| Locale pinning | Geo must not override when `localePinned/timezonePinned` is set |
| Session | `context.close()` triggers the `close` event → dispose must be idempotent |
| Tab index | Indices change after a tab is closed; always return the new list after an action |
| Screencast | The first frame may arrive after a fallback screenshot → avoid overwriting a small frame with a large image |

---

## 6. API smoke test (copy-paste)

Run the server in another terminal:

```bash
VB_HEADLESS=1 VB_PORT=8799 VB_DATA_DIR=/tmp/opencode/vb-smoke npm start
```

In the test shell:

```bash
B=http://127.0.0.1:8799

# 1. health + system
curl -sf $B/api/health | python3 -m json.tool
curl -sf $B/api/system | python3 -m json.tool

# 2. check the direct IP
curl -sf -X POST $B/api/proxy/check \
  -H 'content-type: application/json' -d '{"proxy":null}' | python3 -m json.tool

# 3. create a profile
curl -sf -X POST $B/api/profiles -H 'content-type: application/json' -d '{
  "name":"Smoke test",
  "tags":["demo"],
  "osProfile":"windows",
  "startUrl":"https://example.com/"
}' > /tmp/opencode/profile.json

ID=$(python3 -c "import json;print(json.load(open('/tmp/opencode/profile.json'))['profile']['id'])")
echo "profile=$ID"

# 4. launch (may take 2–15 s because of the geo lookup)
time curl -sf -X POST $B/api/profiles/$ID/launch | python3 -m json.tool

# 5. the thumbnail must be a JPEG
curl -sf -o /tmp/opencode/thumb.jpg $B/api/profiles/$ID/thumbnail
file /tmp/opencode/thumb.jpg

# 6. tab + navigate
curl -sf -X POST $B/api/profiles/$ID/tabs \
  -H 'content-type: application/json' -d '{"url":"https://example.org"}' | python3 -m json.tool
curl -sf -X POST $B/api/profiles/$ID/navigate \
  -H 'content-type: application/json' -d '{"url":"https://example.net"}' | python3 -m json.tool

# 7. check the profile IP (and store geo)
curl -sf -X POST $B/api/profiles/$ID/check | python3 -m json.tool

# 8. stop + delete
curl -sf -X POST $B/api/profiles/$ID/stop | python3 -m json.tool
curl -sf -X DELETE $B/api/profiles/$ID | python3 -m json.tool
```

Also check:

- `GET /api/profiles` does not expose stale runtime data after stop.
- After a server restart, every profile must be `stopped`.
- `GET /api/export` downloads JSON that contains no runtime data.

### Testing a real proxy

```bash
# HTTP proxy with auth
curl -sf -X POST $B/api/proxy/check -H 'content-type: application/json' -d '{
  "proxy":{"type":"http","host":"127.0.0.1","port":8080,"username":"u","password":"p"}
}'

# SOCKS5 with auth
curl -sf -X POST $B/api/proxy/check -H 'content-type: application/json' -d '{
  "proxy":{"type":"socks5","host":"127.0.0.1","port":1080,"username":"u","password":"p"}
}'
```

No real proxy? Run `npm run verify:proxy` — it spins up an in-process HTTP CONNECT proxy and
an authenticated SOCKS5 proxy, and also checks a wrong password.

---

## 7. UI smoke test

Open `http://127.0.0.1:8787` and work through the checklist:

- [ ] Create a "native" profile + leave locale/timezone empty → launch → the card shows geo, locale
      from the country, and the thumbnail updates.
- [ ] Edit a profile: change name/tags → the card updates, proxy data is not lost.
- [ ] Edit a profile: pin locale `en-US`, launch with a Thailand IP → locale stays `en-US`,
      timezone follows geo (unless the timezone is pinned too).
- [ ] Check IP → toast shows IP/country/latency; the card's geo changes.
- [ ] Launch → the tab bar appears; open a new tab; switch tabs; close a tab; Enter in the URL bar navigates.
- [ ] Stop → the thumbnail stops, the badge shows Stopped, the tab panel is hidden.
- [ ] Duplicate → new profile, no shared user-data.
- [ ] Regenerate fingerprint → `seed` changes, the card shows different screen/WebGL values on the next launch.
- [ ] Delete → confirm; the `data/profiles/<id>` directory disappears.
- [ ] Search/tag/os filters work; profiles survive a page reload.
- [ ] If `VB_TOKEN` is set: requests without a token return 401; opening `/?token=...` works.
- [ ] Chrome missing → red banner; wireproxy missing but VPN not used → no banner.

The DevTools Console must have no JS errors; Network must have no repeated 500 requests.

---

## 8. Debugging

### Logging

```bash
VB_LOG_LEVEL=debug npm start
```

### Chrome has locked the user-data dir

Chrome allows only one process per user-data-dir. If the server was killed abruptly:

```bash
pgrep -af 'user-data-dir=.*data/profiles'
# kill the leftover process, or delete SingletonLock in the user-data-dir if you are sure it is not running
```

### Wireproxy

- Check that the config has the block:

```ini
[Socks5]
BindAddress = 127.0.0.1:25344
```

- Run it by hand to see the logs:

```bash
wireproxy -c /path/to/wg.conf
```

- Common errors: missing `PrivateKey`, wrong endpoint, `BindAddress` port conflict.

### Relay/proxy

- Run `npm run verify:proxy` before suspecting Chrome.
- 407 = bad auth; 502 = cannot reach upstream; timeout = the proxy is hung.
- The relay uses a random port; the runtime log returns `proxyServer` in the status.

### Fingerprint

- `npm run verify:fingerprint` must print `OK`.
- If Chrome updates: clear the cached version by restarting the server (the version is detected at startup),
  then run verify again.
- Compare `navigator.userAgentData.getHighEntropyValues()` in the page with the fingerprint.

### Geo

- The provider may rate-limit. `geoError` will show; run Check IP again.
- If the IP is a datacenter IP, the country is still correct but the city may be "Ashburn"… — that is normal.

---

## 9. Data migration

When the `profiles.json` schema changes:

1. Bump `DB.version` in `src/store.ts`.
2. Write a pure `migrate(db)` function with no side effects:
   - add default fields;
   - rename old fields;
   - drop unused fields;
   - keep id/userDataDir unchanged.
3. Call it in `initStore()` after parsing, before assigning `db`.
4. Write the migrated file immediately (once), or write it on the next save — but be consistent.
5. Test: copy an old-version JSON file into `VB_DATA_DIR`, start the server, and check that no
   profile is lost.
6. Record it in CHANGELOG + PROCESS (this section) if there is a manual step.

Principle: **never delete the user-data-dir** during migration.

---

## 10. Release checklist

- [ ] `package.json` + `src/config.ts` share the same version.
- [ ] `npm run typecheck`
- [ ] `npm run verify:proxy`
- [ ] `npm run verify:fingerprint` (if Chrome is available)
- [ ] `npm run verify:ui` against a freshly started server
- [ ] `npm run verify:token` against a server with `VB_TOKEN` (separate port)
- [ ] API smoke from section 6 on a clean `VB_DATA_DIR`.
- [ ] UI smoke from section 7.
- [ ] `docs/CHANGELOG.md` has the version + date entry.
- [ ] `docs/DEVLOG.md` records the work done.
- [ ] `docs/API.md` matches the actual routes (`grep "app\.\(get\|post\|patch\|delete\)" src/server/routes`).
- [ ] The README env table matches `src/config.ts`.
- [ ] No `data/`, log, or `.env` files in the commit.
- [ ] Tag: `git tag v0.2.0 && git push --tags`.

---

## 11. Definition of Done

A task is only "done" when:

1. The behavior matches the requirement and has clear error messages.
2. `npm run typecheck` is clean.
3. The related verify scripts pass.
4. The corresponding API/UI smoke has been run (prefer the `verify:ui` script for CRUD flows).
5. No resources leak after stop/delete/restart (check Chrome processes, wireproxy,
   relay ports).
6. Docs + DEVLOG are updated.
7. Old data is not broken (or a migration + note exists).

---

## 12. Backup & restore

Backup:

```bash
# Stop the server first so the JSON does not change mid-copy
tar -czf vb-backup-$(date +%F).tar.gz data/
```

Restore:

```bash
tar -xzf vb-backup-YYYY-MM-DD.tar.gz
# make sure the user running the server has read/write permissions
```

Export metadata (without cookies):

```bash
curl -sf http://127.0.0.1:8787/api/export -o vb-export.json
```

There is currently **no import**. To restore metadata, stop the server and merge manually into
`data/profiles.json` (keep `id`, make sure `userDataDir` is correct). The import feature is on the
[ROADMAP](ROADMAP.md).
