# Security Policy

## Supported Versions

Security fixes are applied to `main` and released via the latest version tag and container image.

| Version | Supported |
| --- | --- |
| Latest release (`main`) | Yes |
| Older releases | No |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report vulnerabilities privately through GitHub Security Advisories:

- <https://github.com/tunitz/healthvault/security/advisories/new>

Include a clear description of the issue, steps to reproduce or proof-of-concept, affected versions/deployment mode, and potential impact. You will receive an acknowledgement as soon as possible.

## Security Model and Scope

- HealthVault is a **single-user** self-hosted application with **no auth-off mode**. All web routes require an HMAC-signed HTTP-only `hv_session` cookie (scrypt password verification with rate limiting), and machine/MCP endpoints (`/api/agent/*`, `/api/mcp`) require a bearer token or active same-origin session.
- Host allowlists (`HEALTHVAULT_ALLOWED_HOSTS`, never a wildcard) and Origin checks are enforced on all requests.
- SQLite database and backup files are created with owner-only permissions (`0700` dir / `0600` file).
- Always terminate **TLS (HTTPS)** in front of HealthVault when exposing it beyond loopback or a trusted private network (`HEALTHVAULT_COOKIE_SECURE=1`, `HEALTHVAULT_TRUST_PROXY=1`), and keep **Allow LAN access** disabled in Settings → MCP unless required.
