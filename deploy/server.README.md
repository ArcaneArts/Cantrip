# Cantrip Server distribution

Copy `.env.example` to `.env` and export those variables with your process
supervisor before running `start.sh` (Unix) or `start.cmd` (Windows). The
archive includes its own platform-matched Node.js runtime, production
dependencies, and PGlite migrations; PostgreSQL can be selected with
`DATABASE_URL`.

Cantrip does not implement hosted user authentication yet. Do not expose a
server publicly. `CANTRIP_ALLOW_INSECURE_REMOTE=true` is an explicit temporary
opt-in intended for trusted networks or an authenticating reverse proxy.
