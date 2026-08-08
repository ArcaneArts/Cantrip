# Cantrip Codex

Cantrip carries the exact upstream Codex CLI source used by its worker under
`cantrip_codex/upstream/`. The source is a mechanically imported projection of
the official OpenAI Codex repository: the Rust workspace plus the repository
license, notice, and readme. It is not a submodule or a nested Git checkout.

The pinned upstream ref, resolved commit, and CLI version live in
`upstream.json`. `upstream.files.json` records every imported file and content
hash. Cantrip does not patch Codex today. If a future worker requires a Codex
change, add an explicit, reviewable patch mechanism instead of editing the
imported snapshot in place.

## Build

The repository's normal development preparation and worker packaging invoke:

```sh
pnpm codex:build
```

This verifies the snapshot and runs Cargo with the upstream lockfile and pinned
Rust toolchain. Output is cached below `cantrip_codex/.build/` and is never
committed. Worker packages copy the resulting native CLI, code-mode host,
responses proxy, platform sandbox helpers, and a hash-checked runtime manifest
into `bin/`. The bundle also carries the upstream Apache-2.0 `LICENSE` and
`NOTICE`, and the Worker verifies every listed executable and notice before it
starts Codex.

The `0.146.1` tag updated its workspace manifests from development version
`0.0.0` without updating those same local-package version fields in
`Cargo.lock`. The build script copies the verified source into its ignored build
directory and normalizes only those workspace-local versions from Cargo
metadata before invoking `cargo build --locked`. Registry and Git dependency
versions, checksums, and revisions remain exactly as pinned upstream, and the
tracked source snapshot is never modified.

## Manual upstream update

Codex never updates itself inside a released worker. To advance it:

1. Select an official upstream release tag and resolve its peeled commit.
2. Update `ref`, `commit`, and `version` in `upstream.json`.
3. Run `pnpm codex:sync` to replace the tracked projection and regenerate its
   file manifest.
4. Run `pnpm codex:verify` and `pnpm codex:build`.
5. Update Cantrip's tested App Server range and generated protocol fixtures if
   the minor version changed.
6. Run the worker compatibility tests and package each supported target.
7. Review and merge the source update with the matching worker changes.

`codex:sync` refuses a ref that does not resolve to the exact committed SHA or
whose Cargo workspace version differs from `upstream.json`. Updating the JSON
is intentionally manual so no script silently selects a newer release.

The imported source remains licensed by its upstream authors under Apache-2.0;
the exact upstream `LICENSE` and `NOTICE` files are retained in the snapshot.
