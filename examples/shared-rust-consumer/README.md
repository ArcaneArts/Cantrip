# Independent shared Rust consumer

This small executable has its own Cargo workspace and lockfile. It uses all eight
extracted libraries as path dependencies without depending on `cantrip-server`.
It parses configuration, validates and evaluates a schedule, forwards a binary
frame through byte accounting, creates a canonical digest, publishes private
files, closes a log archive, and completes ordered event/response delivery.
Temporary files are removed when the executable exits normally.

From the repository root, reuse the server's shared build cache:

```sh
CARGO_TARGET_DIR="$(git rev-parse --path-format=absolute --git-common-dir)/cantrip/rust-server-target" \
CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 \
cargo run --locked --manifest-path examples/shared-rust-consumer/Cargo.toml
```

The consumer builds ordinary libraries. It does not run the server build script,
generate versions/migrations, discover or link PGlite, or require Node. Its final
JSON record reports success. It initializes its own Tokio runtime and explicit
logging options. This is a library usage example; a worker connection loop and
command execution remain work for the separate Rust worker conversion.
