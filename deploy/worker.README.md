# Cantrip Worker distribution

Copy `.env.example` to `.env` and export those variables with your process
supervisor before running `start.sh` (Unix) or `start.cmd` (Windows). The
package includes its own platform-matched Node.js runtime and the pinned Codex
CLI built and verified with this worker release. Generate a short-lived worker
link code while signed into the target server, place it in
`CANTRIP_WORKER_ENROLLMENT_CODE`, and start the worker once. The code is
single-use; the worker stores only its unique resulting credential and stable
identity in `CANTRIP_WORKER_DATA_DIR/worker-credential.json` with owner-only
permissions. Remove the link code from the environment after enrollment.

For a read-only deployment filesystem, inject `CANTRIP_WORKER_CREDENTIAL` and
its bound `CANTRIP_WORKER_ID` from a secret manager instead. Never copy one
worker's credential to another worker. The worker makes the outbound server
connection; apps never connect to workers directly.

Cantrip Code editor processes stay warm after their last tunnel closes and are
reclaimed after `CANTRIP_CODE_IDLE_TIMEOUT_MS` (30 minutes by default). Durable
session identity, profiles, extensions, and workspace state remain available
for the next authorized attachment.
