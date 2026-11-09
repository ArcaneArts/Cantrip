# Linux native database ABI qualification

The existing container build accepts both `linux/amd64` and `linux/arm64`.
Winterhold's deployment configuration currently selects `linux/amd64`.
The release workflow publishes macOS arm64 and Windows x64 packages; accepted
manual architecture names do not establish completed artifact qualification.
These scopes follow `COMPILING.md`, the release workflow, both server Dockerfiles
and `scripts/deploy-production.mjs`. This change preserves their selections.

## Reproduced ARM64 failure

The original Debian 12 ARM64 container build fails while linking native PGlite.
The published archive references `__isoc23_strtol`, `__isoc23_sscanf` and
`strlcpy`, which its Debian 12 libc does not provide. A successful macOS or x64
build does not detect this mismatch. The actual failed link log is retained.

The native Dockerfile now builds the exact engine source used by pglite-rs
0.2.7 on Debian 12, along with its matching initialization tools, extensions and
runtime data. The engine commit is
`0062c8c2fec03e389f8c2e8cad18391ecf0d53bd` (`engine-06c837c6a303-p3`); its
PostgreSQL fork gitlink is `06c837c6a30335169df786c610ed224bc51d81c0`.
Upstream's runtime relocation bundles libpq and supplies relative library paths.
The source licenses are included in the existing artifact notice collection.

Both Linux architectures use this build stage. Native make and Cargo each use
two jobs, with one Cargo cache per architecture. Docker caches the engine build
separately from Cantrip source. The packaged server needs no engine compiler,
Cargo, JavaScript database helper or first-start download. No libc symbol aliases
or higher minimum distribution version are introduced.

This repair applies to the native container/distribution build. An independent
host build using the published ARM64 archive still needs a compatible libc or
an explicitly supplied matching engine/runtime through `PGLITE_LIB_DIR`.
The Docker distribution export provides the Debian 12-compatible native package.

## Executed artifact identity

The container driver inspects the running service after real HTTP operations
succeed. It reads the actual executable's ELF machine and SHA256, compares its
artifact target, hashes every manifest-listed package file, and checks the four
public version fields against the packaged build metadata. Native database
helpers may share the server executable; process parent relationships identify
the service root.

Under Rosetta, `/proc/<pid>/exe` identifies the interpreter. The driver instead
identifies the mapped server inode and matches it to the immutable container-root
file before reading its ELF bytes and hash. This records emulated x64 execution
accurately rather than calling the interpreter a native x64 server.

The same driver exercises all three database modes, local and hosted reopening,
preserved identity and writes, offline migrations and SQL exports, restart and
clean SIGTERM. It uses UID 10001, a read-only root, a 256 MiB `noexec` temporary
mount, and an image without Node/npm/Cargo. Hosted reopening uses trusted proxy
headers; it is not the separate systemd/Caddy HTTPS rehearsal.

## Local reproduction

Build each architecture locally with a positive commit-count patch version:

```sh
docker buildx build --platform linux/arm64 \
  --file deploy/docker/server-rust.Dockerfile \
  --build-arg CANTRIP_VERSION_PATCH=2783 \
  --tag cantrip-server-rust:local-arm64 --load .

node scripts/server-rust/container-server-acceptance.mjs \
  --image cantrip-server-rust:local-arm64 --architecture arm64 \
  --report /private/path/arm64/report.json
```

Use `linux/amd64` and `--architecture amd64` for the x64 comparison. Actual
reports retain image IDs, executable hashes, versions, process observations,
SQL-export receipts and the exact owned volumes kept for evidence preservation.
Earlier driver failures remain recorded: its first version comparison incorrectly
included build-only metadata, and its first process comparison incorrectly
assumed the server executable appeared only once.

## Executed candidate results

Candidate `1.1.2783` uses Rust source at
`59dbc4f109aff5512f2e48433b4c30aff0d79dbb` with this milestone's native Dockerfile
repair. No production Rust, worker or protocol source changes in this milestone.

| Artifact / operation          | Scope                                                            | Result |
| ----------------------------- | ---------------------------------------------------------------- | ------ |
| Debian 12 ARM64 container     | Three stores, local/hosted, complete container-driver workload   | Passed |
| Debian 12 x64 container       | Same workload, actual x64 ELF under Rosetta                      | Passed |
| Exported ARM64 / Ubuntu 24.04 | Same workload, root-owned native executable assets               | Passed |
| Exported x64 / Ubuntu 24.04   | Same workload, actual x64 ELF under Rosetta                      | Passed |
| ARM64 systemd / Caddy HTTPS   | Three stores, installer failures/recovery, restart and rollback  | Passed |
| x64 systemd / Caddy HTTPS     | Same workload on ARM64 systemd host with x64 libraries / Rosetta | Passed |

All twelve store/distribution pairs verify 2,546 actual package file hashes.
The service rehearsals complete 36 installer steps: 24 successful installations
and twelve intentional candidate failures that recover the previous service and
configuration. Both external PostgreSQL cases preserve sessions and accepted
writes through Node → Rust → Node → Rust. Local-store service rollback uses a
previous native release; it is not a Node/PGlite engine conversion.
Actual public bootstrap responses identify the Node baseline as `1.1.2739`.
Both runs separately observe all six native external PostgreSQL connections
using TLS and hash the actual running server against the exported artifact.

The native ARM64 executable is 105,767,376 bytes, SHA256:

```text
7ecf491d6c52e336f87e68952c0cab4787cd24ed6a931dd4609d7d527357d42a
```

The x64 executable is 110,704,592 bytes, SHA256:

```text
30e9fbbca80b808aece113e4d68b09c6a075745188f62bf49f58d8ceb4f1c081
```

The native distribution archives are 138,197,074 bytes (ARM64), SHA256
`dcdf748b9bb27f5689d9fc699aa985d7ec23f921c0f2e971ca4b9a646f8ef35f`,
and 142,400,652 bytes (x64), SHA256
`eff5ec7bee5323426ccda73cb699a670d8e5ea278bb5f3e1abe734e4bd871097`.
The four exact image IDs and per-run receipts are retained in
`.qa/rust-linux-arm64/final-acceptance-v1.json` before independent archival.
Service fixtures are stopped after preserving their data and runtime evidence.
These executions establish the recorded Linux ABI/service behavior; they are
not bare-metal x64 performance measurements or a production Winterhold deploy.

All 33 focused packaging/deployment/policy tests, server-boundary audit, syntax,
formatting and diff checks pass locally. The aggregate `pnpm check` stops at
the Node file budgets `build-app.ts` 1,539/1,500 and `chat-turn-runtime.ts`
2,329/1,999. Clean Primary reproduces both failures; later aggregate stages
were not run or claimed passing.

The full replacement remains incomplete: existing-client desktop encryption and
update acceptance, final integrated shipping artifacts and the remaining original
acceptance requirements, Rust defaults and production Node-server removal are
separate. The worker remains Node. Development validation remains local.
