# Cantrip Worker distribution

Copy `.env.example` to `.env` and run `start.sh` on Unix or `start.cmd`
on Windows. The launcher opens the native worker in the package directory
and forwards arguments. The worker loads `.env` and gives variables from
its supervisor precedence. The package includes the pinned Codex runtime
and native `cantrip` CLI. Managed Codex and terminal processes use that
CLI through a protected connection to the local worker broker.
Generate a short-lived worker link code while signed into
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

Code viewing and editing runs in the client. The worker supplies encrypted file
operations and does not install or launch an editor server.

The supported Linux container is headless: repository, Codex, terminal, and
Code capabilities work, but host GUI browser/desktop capture does not. Persist
the entire worker data directory and never clone it to manufacture another
worker identity.

The worker package also includes `bin/cantrip-cua` (`.exe` on Windows), the
first-party computer-use helper. Packaging executes its actual private protocol
and deterministic capture smoke. The desktop distribution signs its nested
macOS helper separately from the standalone worker artifact.

Windows x64 packages place the Visual C++ runtime DLLs alongside the native
helpers. When building a package on Windows, the packager finds the DLLs
through Visual Studio or `VCToolsRedistDir`. Set
`CANTRIP_WINDOWS_VC_REDIST_DIR` to specify the x64 redistributable directory.
