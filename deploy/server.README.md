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

Hosted mode also requires `CANTRIP_SECRET_ENCRYPTION_KEYS`, a JSON object whose
values are canonical base64 encodings of 32 random bytes. Set
`CANTRIP_ACTIVE_SECRET_ENCRYPTION_KEY_ID` when the keyring contains more than
one entry. Add a new key, make it active, restart successfully so existing
provider secrets are rewrapped, take a verified backup, and only then retire an
old key. Losing the keyring makes encrypted provider credentials unrecoverable.
