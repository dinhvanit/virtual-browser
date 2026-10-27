# Fingerprint

The goal is not "spoofing the most things", but **not being contradictory**. A profile with
fewer surfaces but consistent is usually safer than a profile that spoofs 20 things but
whose UA says Windows, WebGL says Apple M2, timezone says Berlin, and IP is in Bangkok.

---

## 1. Consistency principles

| Value pair | Rule |
| --- | --- |
| `userAgent` ↔ `userAgentData` ↔ Chrome binary | same `chromeVersion` obtained from the real Chrome |
| `navigator.platform` ↔ UA ↔ WebGL driver | Windows ↔ Win32 ↔ ANGLE D3D11; macOS ↔ MacIntel ↔ ANGLE Metal |
| `navigator.language/languages` ↔ `Accept-Language` ↔ context locale | same `locale` |
| `Intl` timezone ↔ geo IP | same country (unless the user pins it) |
| `screen` ↔ `window-size` ↔ viewport ↔ DPR | same set in `Fingerprint` |
| `hardwareConcurrency` ↔ `deviceMemory` | plausible desktop values (8–16) |
| `navigator.webdriver` ↔ launch args | `false` + `--disable-blink-features=AutomationControlled` |
| WebGL vendor ↔ renderer | same GPU pair in the preset |
| Client hints headers ↔ JS `userAgentData` | CDP `Emulation.setUserAgentOverride` + init script |
| WebRTC ↔ proxy | `disable_non_proxied_udp` when a proxy is present |

`generateFingerprint()` uses **a single seed** for all choices, so fields cannot "drift out
of phase" due to independent randomness.

---

## 2. Seed & fingerprint generation

```text
seed = profile.id (at creation)
        │
        ▼
FNV-1a hash → mulberry32 PRNG
        │
        ├─ pick locale/timezone preset (if not pinned)
        ├─ pick screen + deviceScaleFactor
        ├─ pick WebGL vendor/renderer (windows/macos only)
        ├─ pick hardwareConcurrency ∈ {8,12,16}
        ├─ pick deviceMemory ∈ {8,16}
        └─ pick colorScheme (15% dark)
```

- Same seed → same fingerprint (reproducible, easy to debug).
- Import/restore preserves the fingerprint **and its seed**, even though the profile receives
  a new local id. This keeps restored logins on the same identity; duplicating a profile
  creates a new seed instead.
- "Regenerate fingerprint" creates a new seed (`newId()`), so all choices change.
- Changing `osProfile` regenerates with the old seed + an OS suffix; the stable "personality"
  is preserved.

### Chrome version

`chromeVersion()` runs `google-chrome --version` once per process and caches it. The UA uses
the full version; client hints use the major + full version. If detection fails, it uses
`VB_CHROME_VERSION` or falls back to `150.0.0.0`.

> After updating Chrome, **restart the server** so the new version is detected again.

### OS profile

| `osProfile` | Behavior |
| --- | --- |
| `native` | UA/platform follow the host; WebGL/hardware are **not** patched; locale/timezone come from the system if no geo is available |
| `windows` | Windows NT 10.0 UA; `Win32`; patches WebGL ANGLE D3D11, hardware, and client hints platform Windows |
| `macos` | Macintosh Intel 10_15_7 UA; `MacIntel`; patches WebGL ANGLE Metal, hardware, and client hints macOS |

The macOS preset currently uses an Intel UA (not an Apple Silicon UA) to keep `platform`
and WebGL consistent. This is a deliberate choice; if you need an Apple Silicon UA, you
must add a new preset and update `verify-fingerprint.ts`.

---

## 3. Geo → locale/timezone

`applyGeo(fingerprint, geo)`:

1. `countryCode` → locale via the `src/lib/geo-locale.ts` table (US→en-US, DE→de-DE,
   VN→vi-VN…).
2. `geo.timezone` if it is a valid IANA name → canonicalize with ICU (`Asia/Ho_Chi_Minh` →
   `Asia/Saigon`, `Europe/Kyiv` → `Europe/Kiev`).
3. If `localePinned` → keep the user's locale.
4. If `timezonePinned` → keep the user's timezone.

Canonicalization matters because Chrome returns `Intl.DateTimeFormat().resolvedOptions().timeZone`
using the ICU name; storing a different name would make the metadata diverge from the page.

### Pin or auto?

- **Auto** (default): locale/timezone follow the egress IP. Suitable for profiles tied to a
  fixed proxy.
- **Pin locale**: a Vietnamese user who wants an English UI but a US IP is still plausible
  (expat).
- **Pin timezone**: rarely used; only when you need to match a work schedule.

UI: leave empty = auto; enter a value = pin. API: send `null` to remove the pin.

---

## 4. What is spoofed

### 4.1 Via Playwright context options

| Surface | Mechanism |
| --- | --- |
| `navigator.userAgent` | `userAgent` |
| `navigator.language(s)` | `locale` |
| `Intl` timezone | `timezoneId` |
| viewport / screen / DPR | `viewport`, `screen`, `deviceScaleFactor` |
| `prefers-color-scheme` | `colorScheme` |
| `Accept-Language` header | `extraHTTPHeaders` |

### 4.2 Via CDP (`Emulation.setUserAgentOverride`)

- `userAgent`
- `acceptLanguage`
- `platform`
- `userAgentMetadata`:
  - `brands`, `fullVersionList`, `fullVersion`
  - `platform`, `platformVersion`, `architecture`, `model`, `mobile`, `bitness`, `wow64`

Applied to each page at creation and before navigation through the API. Pages opened by the
site itself (`window.open`) are patched as soon as Playwright emits the `page` event, but the
popup's first request may already have started — a known limitation.

### 4.3 Via init script (every frame)

`fingerprintInitScript(fp)` runs before the page's own scripts:

| Property | Value |
| --- | --- |
| `navigator.webdriver` | `false` |
| `navigator.platform` | `fp.platform` |
| `navigator.hardwareConcurrency` | 8/12/16 |
| `navigator.deviceMemory` | 8/16 |
| `navigator.language`, `languages` | per locale, as `[locale, base]` |
| `navigator.userAgent`, `appVersion` | per fp |
| `navigator.vendor` | `Google Inc.` |
| `navigator.userAgentData` | brands, platform, `getHighEntropyValues()` |
| `navigator.plugins`, `mimeTypes` | desktop PDF viewer set |
| `window.chrome.runtime` | empty object (like regular Chrome) |
| WebGL `UNMASKED_VENDOR_WEBGL` / `UNMASKED_RENDERER_WEBGL` | per fp (via `getParameter` 37445/37446 and the extension) |

All getters use `Object.defineProperty` on the prototype with `configurable: true`.

### 4.4 Launch args

| Arg | Purpose |
| --- | --- |
| `--disable-blink-features=AutomationControlled` | hides Chromium's automation markers |
| `ignoreDefaultArgs: ["--enable-automation"]` | Playwright does not enable the automation banner |
| `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` | blocks WebRTC UDP from going direct when a proxy is present |
| `--lang=<locale>` | UI/engine language |
| `--password-store=basic` | avoids the keyring prompt on Linux |
| `--no-sandbox` | added on Linux only (dev/container environments) |

---

## 5. Verification

```bash
npm run verify:fingerprint
```

Script:

1. Generates a fingerprint with a fixed seed and OS `windows`.
2. Opens headless Chrome with the exact context options + init script.
3. Reads back from the page: UA, webdriver, platform, languages, hardware, deviceMemory,
   Intl timezone, `userAgentData` + high entropy, `window.chrome`, screen/DPR, WebGL vendor +
   renderer (including the debug extension).
4. Compares each field; prints mismatches and exits with code 1 if anything diverges.

This script is the **contract** between the code and the browser. When adding a new surface,
add the corresponding assert.

---

## 6. Known limitations

| Surface | Status | Risk |
| --- | --- | --- |
| Canvas fingerprint | Not spoofed | the real GPU/OS still produces a hash different from another profile with the "same fingerprint" |
| WebAudio | Not spoofed | audio hash |
| Fonts | Not spoofed | the host's font list may reveal Linux/Windows |
| TLS/JA3 | **Real Chrome** (good) | mismatch if a profile spoofs an OS different from the host? JA3 does not depend much on OS |
| WebRTC | Mitigated by policy | may still leak the public IP if the policy is bypassed |
| Client hints of the popup's first request | May diverge | the page event arrives after the request has started |
| `navigator.plugins` | Fake object, not a `PluginArray` | advanced JS can detect it |
| Geolocation API | Not spoofed | real location if the user grants permission; Chrome will prompt |
| Media devices | Not spoofed | real device count/IDs |
| Battery, Bluetooth, USB | Not spoofed | rarely used for fingerprinting |
| DNS | Follows the proxy (SOCKS5 domain / CONNECT hostname) | direct means real DNS |
| HTTP/2 fingerprint | Real Chrome | good |
| Timezone alias | Canonicalized | already handled |
| Screen vs actual window | Window size may be scaled by the OS | `--window-size` + viewport |

### Operational recommendations

- One profile = one account = one stable IP. Changing proxies constantly makes
  geo/fingerprint jump around.
- Warm-up: open a few real pages, scroll/click naturally before doing the main work.
- Do not enable/disable the proxy mid-session. Stop → change → launch again.
- With an `osProfile` different from the host, avoid native features such as font rendering,
  extensions, and heavy WebGL apps; the risk of exposing the host increases.
- Do not use headless for real profiles (`VB_HEADLESS=0`).

---

## 7. Adding a new surface (e.g., canvas noise)

1. Add a field to `Fingerprint` (`canvasSeed?: string`).
2. Generate it in `generateFingerprint` from a picker.
3. Patch it in `fingerprintInitScript` **before** the page runs; keep it deterministic per
   seed (same profile → same canvas hash).
4. Add an assert to `scripts/verify-fingerprint.ts`.
5. Document it in the tables in §4, §6, CHANGELOG, and DEVLOG.
6. Test with at least 3 different seeds, ensuring the hash is stable within a session and
   different across profiles.

Non-negotiable criteria: **do not hang the page**, **do not skew other surfaces**, **do not
increase entropy in an easily detectable direction** (for example, every profile using the
same noise pattern).
