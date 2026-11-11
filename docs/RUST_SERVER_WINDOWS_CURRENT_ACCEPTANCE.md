# Current Windows native server qualification

The `1.1.2819` Windows x64 native server was built from
`2ec06de47a6bdd58439c0ad04cfaea0e3922d995`. The local Windows 11 ARM64 guest
runs build 27754 and executes x64 binaries through Windows emulation. Its owned
APFS clone has an independent registered disk and an isolated fixture share.

The standalone distribution passes PGlite, private PostgreSQL and external
PostgreSQL through the normal batch launchers. Each backend retains identity and
accepted settings after restart, reopens in hosted mode, exports SQL, applies
migrations and shuts down through supervision EOF. Configuration precedence,
UTF-8 launchers, embedded native runtime fallback and paths containing spaces
and emoji pass. Node is absent from the server runtime PATH.

The accepted distribution contains 2,278 manifest files. Host-side inspection
of the exported archive independently checks every member's bytes and SHA256,
the manifest, archive member paths and the native executable. The
[acceptance record](security/rust-server-win32-x64-acceptance.json) retains the
source, artifact hashes and individual report hashes.

## Desktop service supervision

The optimized `desktop_runtime_probe` compiles the actual desktop service
launcher and supervision source. Its server-only run passes all three stores,
including encrypted account-profile initialization, accepted settings, retained
identity, normal shutdown, server-child reaping, abrupt supervisor loss and
reopening. The report explicitly records `actualWorker: false` for this run.

The attempted full-worker run used the published `1.1.2397` Windows worker and
failed before worker enrollment. A direct import of its `@noble/curves` NIST
module also fails with `Cannot find square root` under the shipped and official
x64 Node `v24.22.1`, including the `--jitless` control. The same 125 extracted
crypto modules have matching hashes on both hosts. The module imports under
native ARM64 Windows Node `v24.22.1` and native ARM64 macOS Node `v24.22.1`.
The current worker's NIST module has the same SHA256 as that published module.
Full current-worker desktop execution and Windows installer/update acceptance
remain open.

## Historical profile and post-write rollback

The published `1.1.2397` Node server created and cleanly stopped the disposable
PGlite source profile. The production desktop launcher converted it, retained
the original backup byte-for-byte and reopened the native profile with its
original identity. A preference written by Rust survived restart, logical
reverse conversion and reopening in the published Node server. A subsequent
Node write survived native re-upgrade. The separate four-step report records
the original 1,660-file profile digest throughout that round trip.

The existing full profile-upgrade driver passes all eight cases. It exercises converter
startup failure, fresh and unmarked profiles, explicit backend selection with
invalid saved metadata, actual migration-history failure, missing active-root
recovery and interruption of a real owned converter. Its final result and scope
are recorded in the acceptance record.

## Acceptance harness repairs

The reference-process fixture now uses a test-only stdin adapter on Windows.
EOF invokes the published server's existing SIGTERM shutdown handlers and the
fixture still requires exit code zero. The application entrypoint and its
shutdown implementation come from the published archive. Native-platform and
Windows-adapter regression cases execute the actual handler and verify exit.

Journal comparisons normalize both real paths to Windows namespace form before
checking the original profile backup. The interruption test observes actual
Windows process parents and executable names through a native Toolhelp snapshot
in the existing test-only fixture. It hard-kills the native owner and requires
both converter descendants to exit. Unix process
observation and signal assertions retain their existing behavior.

Earlier attempts remain in the retained evidence. The first exploratory
rollback driver omitted the bundled PostgreSQL tools argument and failed
during export. Supplying the packaged tools passed the round trip. The full
driver then exposed the Windows journal-path spelling and process-observation
issues repaired here. Shell and WMI startup exceeded the actual conversion
duration, so the interruption driver now uses the native fixture's snapshot.
The original full-worker failure and its controls remain
separate from the passing server-only run.

## Retained evidence and remaining work

Reports and source scripts are retained under
`rust-server-current-windows-20261110-v1` in the local QA evidence directory.
The principal drivers are `packaged-server-acceptance.mjs`,
`desktop-runtime-acceptance.mjs` and
`desktop-profile-upgrade-compatibility.mjs` under `scripts/server-rust`.
The exported native distribution and guest profile/log archive accompany the
reports. Development validation ran locally.

The original replacement goal remains open for the full Windows desktop and
installer/update matrix, encrypted macOS signed updates, remaining product and
coordination interruption cases, broader historical profiles and representative
performance. The [acceptance reconciliation](RUST_SERVER_ACCEPTANCE_RECONCILIATION.md)
tracks the current scope.
