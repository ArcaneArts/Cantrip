# Cantrip Rust worker distribution

This standalone package starts the Rust worker directly. It includes the
bundled Codex runtime, Cantrip CLI and native computer-use helper. The Rust
worker port is in progress. Use a dedicated profile for this package and keep
its data directory outside the generated artifact for persistent installations.

Copy `.env.example` to `.env` and set `CANTRIP_SERVER_URL`. Generate a
short-lived link code from the signed-in Cantrip app and set
`CANTRIP_WORKER_ENROLLMENT_CODE` for the initial start. Run `start.sh` on
Unix or `start.cmd` on Windows. The launcher runs from the package directory,
and the worker reads `.env` there. Environment variables from a supervisor
override file settings. Both launchers forward arguments to the worker.

After enrollment, remove the link code. The data directory holds the worker's
stable identity, enrolled credential and other persistent state. Restrict access
to this directory and preserve it when updating the package. For secret-manager
injection, set `CANTRIP_WORKER_CREDENTIAL` with its bound `CANTRIP_WORKER_ID`.
The worker makes the outbound connection to Cantrip Core.

On Windows x64 the packager places the Visual C++ runtime DLLs alongside
the native binaries. Set `CANTRIP_WINDOWS_VC_REDIST_DIR` on the build host
to select a Visual Studio redistributable directory.
