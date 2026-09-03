# Cantrip Server distribution

Copy `.env.example` to `.env` and run `start.sh` (Unix) or `start.cmd`
(Windows); the launchers load `.env` themselves with Node's
`--env-file-if-exists`. A supervisor may instead inject the equivalent
variables. The archive includes its own platform-matched Node.js runtime,
production dependencies, and PGlite migrations; PostgreSQL can be selected
with `DATABASE_URL`.

Run `migrate.sh` (or `migrate.cmd`) for a migration-only deployment job. Normal
startup also applies pending migrations. Production container, Compose,
reverse-proxy, backup, restore, and rolling-upgrade instructions live in
`docs/HOSTED_DEPLOYMENT.md` in the source release.

`CANTRIP_AUTH_MODE=password` protects one personal owner with an Argon2id hash.
`CANTRIP_AUTH_MODE=accounts` enables email/password sessions. Account
registration is license-whitelisted by default and requires
`CANTRIP_ADMIN_EMAIL`; that administrator creates the first account, and later
registrants must be whitelisted. Set
`CANTRIP_LICENSE_WHITELIST_ENABLED=false` only when open registration is
intended. Hosted account workers enroll through signed-in users with short-lived
link codes and receive independently revocable credentials. The legacy shared
worker token is accepted only by anonymous loopback pnpm-dev and embedded Tauri
bootstraps.

Hosted startup fails closed unless it has password/account authentication,
PostgreSQL, explicit application origins, one HTTPS
`CANTRIP_PUBLIC_ORIGIN`, and a bounded `CANTRIP_TRUSTED_PROXIES` list. The
single `CANTRIP_SERVER_HOST` / `CANTRIP_SERVER_PORT` listener carries the API
and control/data WebSockets; there is no separate Code listener or public Code
origin. Terminate TLS at an explicitly trusted peer and preserve the public
host plus `X-Forwarded-Proto: https`; direct or ambiguous forwarding headers
are rejected. The API applies no-store and browser security headers. JSON,
upload, and WebSocket payload ceilings are configurable independently, while
legitimate long-running agent work has no short global request timeout.

Hosted mode currently also requires `CANTRIP_SECRET_ENCRYPTION_KEYS`, a JSON
object whose values are canonical base64 encodings of 32 random bytes. Set
`CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID` when the object contains more than
one entry. This is a compatibility startup requirement at this revision:
provider API keys, provider-account labels and OAuth bundles, and MCP
configurations use account endpoint encryption instead. The server stores and
routes those values as opaque envelopes and cannot decrypt or rewrap them with
the server keyring.
