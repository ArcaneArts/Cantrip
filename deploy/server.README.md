# Cantrip Server distribution

Copy `.env.example` to `.env` and export those variables with your process
supervisor before running `start.sh` (Unix) or `start.cmd` (Windows). The
archive includes its own platform-matched Node.js runtime, production
dependencies, and PGlite migrations; PostgreSQL can be selected with
`DATABASE_URL`.

`CANTRIP_AUTH_MODE=password` protects one personal owner with an Argon2id hash.
`CANTRIP_AUTH_MODE=accounts` enables email/password sessions and requires either
public registration or a one-time first-owner bootstrap token. Hosted account
deployment is still incomplete until tenant-wide ownership enforcement and
per-worker enrollment land; do not expose this intermediate build publicly.
