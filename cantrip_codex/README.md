# Cantrip Codex

Cantrip carries the exact upstream Codex CLI source used by its worker under
`cantrip_codex/upstream/`. The source is a mechanically imported projection of
the official OpenAI Codex repository: the Rust workspace plus the repository
license, notice, and readme. It is not a submodule or a nested Git checkout.

The pinned upstream ref, resolved commit, and CLI version live in
`upstream.json`. `upstream.files.json` records every imported file and content
hash. Cantrip-specific compatibility patches live in `patches/`. The tracked
upstream snapshot remains pristine and hash-verified; build preparation applies
every reviewed patch in filename order to an ignored source copy.

## Build

The repository's normal development preparation and worker packaging invoke:

```sh
pnpm codex:build
```

This verifies the snapshot and patch series, then runs Cargo with the upstream
lockfile and pinned Rust toolchain. Output is cached below
`cantrip_codex/.build/` and is never
committed. Worker packages copy the resulting native CLI, code-mode host,
responses proxy, platform sandbox helpers, and a hash-checked runtime manifest
into `bin/`. The bundle also carries the upstream Apache-2.0 `LICENSE` and
`NOTICE`, and the Worker verifies every listed executable and notice before it
starts Codex.

Upstream release tags update their workspace manifests from development
version `0.0.0` without updating those same local-package version fields in
`Cargo.lock`. The build script copies the verified source into its ignored
build directory and normalizes only those workspace-local versions from Cargo
metadata before invoking `cargo build --locked`. Registry and Git dependency
versions, checksums, and revisions remain exactly as pinned upstream, and the
tracked source snapshot is never modified. The runtime manifest fingerprints
the ordered patch set so changing a patch invalidates cached binaries.

Codex 0.150.1 continues to use Rusty V8's heap sandbox for the code-mode host. Those
artifacts are published on a separate official OpenAI Codex release rather than
the upstream Rusty V8 release. The build resolves the pinned `v8` crate version
and native Rust host target, downloads the same archive and generated binding
used by Codex's release workflow, verifies both against OpenAI's two-entry
SHA-256 manifest, and supplies them to Cargo. This preserves the upstream V8
sandbox without compiling V8 from source on every Cantrip target.

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
