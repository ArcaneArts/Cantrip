# Native Cantrip worker

This package is the incremental Rust worker replacement. See
[the implementation ledger](../docs/RUST_WORKER_PORT.md) for scope, current
coverage, compatibility and delivery milestones.

Currently implemented: worker configuration/authentication precedence,
version-1 identity and credential persistence, and Codex installation resolution.
These use `cantrip-config`, `cantrip-wire` and `cantrip-host`, with no server,
database or server build-script dependency. Host paths/hostname/platform are
explicit inputs. Credential-bearing structures deliberately omit `Debug`.

There is not yet a production native worker executable. Production packaging
continues selecting the existing Node worker until the complete implementation
is ready. The `config-fixture` example is a development-only differential driver
that emits synthetic secrets; never run it against a real worker profile.

Run `pnpm worker:rust:check` and `pnpm worker:rust:test` locally. The worker Cargo
wrapper shares the bounded server/library cache without discovering PGlite.
Keep direct Cargo invocations on that shared target directory as well.
