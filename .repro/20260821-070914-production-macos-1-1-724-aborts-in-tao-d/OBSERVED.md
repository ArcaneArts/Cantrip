# Observed Behavior

- The updater stopped the 1.1.659 bundled services, installed 1.1.724, and relaunched the app.
- The 1.1.724 server started database initialization but exited before readiness on both the updater relaunch and the subsequent manual reopen.
- Direct reproduction against a disposable copy failed on:

  `ALTER TABLE "model_provider_accounts" ADD COLUMN "protected_label" jsonb NOT NULL;`

- PGlite reported PostgreSQL error `23502`: `column "protected_label" of relation "model_provider_accounts" contains null values`.
- Tauri propagated the runtime startup error out of `.setup(...)`. On macOS that callback runs through an Objective-C application delegate that cannot unwind, so Rust called `panic_cannot_unwind` and the process ended with `SIGABRT`.
- The server child uses null stdout/stderr, and the structured archive retained only `errorClass: "Error"`; this is why the actionable migration message was absent from the crash dialog and normal logs.
