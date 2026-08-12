# Cantrip Server distribution

Copy `.env.example` to `.env` and export those variables with your process
supervisor before running `start.sh` (Unix) or `start.cmd` (Windows). The
archive includes its own platform-matched Node.js runtime, production
dependencies, and PGlite migrations; PostgreSQL can be selected with
`DATABASE_URL`.

`CANTRIP_AUTH_MODE=password` protects one personal owner with an Argon2id hash.
`CANTRIP_AUTH_MODE=accounts` enables email/password sessions and requires either
public registration or a one-time first-owner bootstrap token. Hosted account
workers enroll through signed-in users with short-lived link codes and receive
independently revocable credentials. The legacy shared worker token is accepted
only by anonymous loopback pnpm-dev and embedded Tauri bootstraps.

Hosted startup fails closed unless it has password/account authentication,
PostgreSQL, explicit application origins, distinct HTTPS API and Code surface
origins, and a bounded `CANTRIP_TRUSTED_PROXIES` list. Terminate TLS at one of
those explicitly trusted peers and preserve the public host plus
`X-Forwarded-Proto: https`; direct or ambiguous forwarding headers are rejected.
The API applies no-store and browser security headers. JSON, upload, and
WebSocket payload ceilings are configurable independently, while legitimate
long-running agent work has no short global request timeout.

Hosted mode also requires `CANTRIP_SECRET_ENCRYPTION_KEYS`, a JSON object whose
values are canonical base64 encodings of 32 random bytes. Set
`CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID` when the keyring contains more than
one entry. Add a new key, make it active, restart successfully so existing
provider secrets are rewrapped, take a verified backup, and only then retire an
old key. Losing the keyring makes encrypted provider credentials unrecoverable.
