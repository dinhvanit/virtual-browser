# Security Policy

Virtual Browser is a local-first tool that handles browser sessions, proxy credentials, and
WireGuard configs. Security reports are welcome and taken seriously.

## Supported versions

| Version | Supported |
| --- | --- |
| `0.2.x` | ✅ |
| `< 0.2` | ❌ |

Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:

1. Go to <https://github.com/dinhvanit/virtual-browser/security/advisories/new>
2. Describe the issue, impact, and affected version.
3. Include reproduction steps or a minimal proof of concept if possible.

If private reporting is unavailable, contact the maintainer through
<https://github.com/dinhvanit> and ask for a private channel. Do not include credentials,
cookies, or personal browsing data in the first message.

### What to include

- Affected version/commit and operating system.
- Configuration relevant to the issue (for example `VB_HOST`, whether `VB_TOKEN` is set).
  **Redact** tokens, proxy passwords, WireGuard keys, and profile data.
- Steps to reproduce.
- Impact: what an attacker can read, change, or execute.
- Any suggested mitigation.

### What to expect

- Acknowledgement within **72 hours** (best effort).
- Triage and severity assessment within **7 days**.
- A fix or mitigation plan for confirmed issues, coordinated disclosure, and credit if you
  want it.

This is a volunteer project; no bug bounty is offered.

## Scope

In scope:

- Authentication/authorization bypass of the local API (`VB_TOKEN`, CSRF/Host guards).
- Path traversal or arbitrary file read/write through profile, store, or export endpoints.
- Command injection through proxy/VPN configuration or profile fields.
- Relay/upstream proxy flaws that leak credentials or allow SSRF beyond the intended
  profile network path.
- Cross-profile data leakage (cookies, storage, screenshots, runtime state).
- Secret exposure in logs, error messages, exports, or the UI.
- Remote code execution, privilege escalation, or denial of service caused by the server.

Out of scope:

- Running with `VB_HOST=0.0.0.0` and no `VB_TOKEN`/firewall (explicitly unsupported).
- The lack of malware sandboxing or VM isolation (documented limitation).
- Fingerprint detection by third-party anti-fraud systems (no tool can guarantee evasion).
- Vulnerabilities in Chrome, Node.js, `wireproxy`, proxies, or VPN providers.
- Issues that require an already-compromised local machine or physical access.
- Social engineering.

## Secure deployment checklist

- Keep `VB_HOST=127.0.0.1`.
- Set `VB_TOKEN` on shared machines and open the UI with `/?token=...` once.
- Restrict `data/` permissions (`chmod 700`); `profiles.json` contains proxy passwords.
- Never commit `data/`, `.env`, WireGuard configs, or logs.
- Use dedicated proxies/VPNs and accounts you are authorized to access.

Full threat model and hardening notes: [docs/SECURITY.md](docs/SECURITY.md).

## Safe harbor

Good-faith research that follows this policy will not be pursued or reported. Do not access
other people's data, degrade service, or test against systems you do not own.
