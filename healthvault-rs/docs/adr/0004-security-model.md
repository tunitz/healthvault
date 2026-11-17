# ADR 0004: Security profiles for desktop and service modes

- Status: accepted (2026-11-17)
- Context: the TypeScript app uses mandatory credentials, scrypt hashes, HMAC session cookies,
  bearer tokens, trusted-host/same-origin checks, throttling and private file modes. Transport
  security depends on deployment.
- Decision: preserve that policy in `hv-api::auth` for `hv-server` (including `scrypt:N:r:p`,
  `v1.exp.mac`, constant-time comparison, 5 failures/15 min, `no-store`/`Vary`, Clear-Site-Data on
  logout). `hv-server` binds `127.0.0.1:3040` by default; LAN binding requires an explicit env
  override. The GPUI app opens local files directly, so its threat model is OS file permissions
  and backup hygiene, not a cookie; it never starts an HTTP listener.
- Consequences: two explicit profiles; no implicit network exposure. TLS remains a deployment
  responsibility when the service is exposed beyond loopback.
