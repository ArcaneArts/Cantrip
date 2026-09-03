# Cantrip Worker distribution

Copy `.env.example` to `.env` and run `start.sh` (Unix) or `start.cmd`
(Windows); the launchers load `.env` themselves with Node's
`--env-file-if-exists`. A supervisor may instead inject the equivalent
variables. The package includes its own platform-matched Node.js runtime and the pinned Codex
CLI built and verified with this worker release. It also includes the native
`cantrip` CLI. The worker places that CLI on the `PATH` of its managed Codex
and terminal processes and gives it a protected connection to a local
authenticated broker; the worker credential is never copied into the CLI
connection cache. Generate a short-lived worker link code while signed into
the target server, place it in
`CANTRIP_WORKER_ENROLLMENT_CODE`, and start the worker once. The code is
single-use. On first enrollment the worker stores its stable ID in
`CANTRIP_WORKER_DATA_DIR/worker-identity.json`, and stores the enrolled
credential together with the bound worker ID and server origin in
`worker-credential.json`; both files are owner-only (`0600` on Unix). Remove
the link code from the environment after enrollment.

For a read-only deployment filesystem, inject `CANTRIP_WORKER_CREDENTIAL` and
its bound `CANTRIP_WORKER_ID` from a secret manager instead. Never copy one
worker's credential to another worker. The worker makes the outbound server
control connection. Authorized apps may then use direct WorkerLink carriers or
the server relay for scoped feature data.

Cantrip Code editor processes stay warm after their last tunnel closes and are
reclaimed after `CANTRIP_CODE_IDLE_TIMEOUT_MS` (30 minutes by default). Durable
session identity, profiles, extensions, and workspace state remain available
for the next authorized attachment.

The supported Linux container is headless: repository, Codex, terminal, and
Code capabilities work, but host GUI browser/desktop capture does not. Persist
the entire worker data directory and never clone it to manufacture another
worker identity.
