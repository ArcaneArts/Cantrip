# Current Windows native server qualification

## Windows x64 standalone `1.1.2845`

The `1.1.2845` Rust server from `5f4d4691d1b83b8216e9d0f194c7f9d3217aa298`
was built with Rust 1.95 and the release workflow's `x86_64-pc-windows-gnu`
target. The production packager ran in a Windows 11 x64 QEMU guest using
the verified PostgreSQL 18.6 assets and their bundled runtime DLLs. The
packaged executable matches the build output byte for byte.

The relocated distribution passed PGlite, bundled PostgreSQL and external
PostgreSQL. Each mode ran migrations, exported SQL, retained its identity and
accepted setting across restart and hosted reopening, and shut down cleanly
on supervision EOF. The suite verified the Windows batch launchers, embedded
PGlite fallback, configuration precedence and all 2,281 package files. The
server ran with Node absent from its runtime PATH. The Windows test driver
used a 240-second readiness observation window for software emulation.

The initial macOS transfer tarball contained AppleDouble metadata that the
Windows manifest tool interpreted as executables. The corrected transfer
matched 1,586 PostgreSQL payload files and contained zero sidecars. The
packager then exited zero. The transfer volume filled while copying the
completed archive, which was recovered from a read-only guest disk snapshot.
An independent comparison matched all archived files to the guest manifest
and matched the three SQL exports to their runtime receipts.

The exact archive, executable, manifest and matching disk and serial reports
are retained. Installed-app qualification for this version is tracked
separately from the standalone run.
[Windows acceptance record](security/rust-server-win32-x64-acceptance.json#currentNativeStandalone)

## Installed Windows x64 update and historical PGlite profile

The installed `1.1.2839` app cold-started the native server with PGlite in a
Windows 11 x64 QEMU guest. The bundled worker enrolled, loaded its packaged
computer-use addon and answered the real worker version command.

The production desktop updater rejected a changed installer with
`update_signature_invalid`, then installed and relaunched the signed
`1.1.2841` app. The relaunched app kept the server identity, the PGlite
selection and the preference written before the update. The worker answered
the same command before and after the update. All 14,090 installed files
matched the signed NSIS package. The updater used a local signing key and
TLS fixture. Both app builds contained the `1.1.2834` server and worker.

The installed `1.1.2841` app also converted an archived Node PGlite profile.
The first observer timed out while the app was converting. The same process
subsequently opened the native profile, kept its identity and preference,
and received a real response from the bundled worker. An independent
read-only disk inspection matched all 1,660 original backup files to the
archived profile. The [acceptance record](security/rust-server-win32-x64-acceptance.json)
contains artifact and report checksums.

## Installed Windows x64 PostgreSQL profiles

The same signed `1.1.2841` app opened a fresh bundled PostgreSQL profile. The
first observer reached HTTP readiness and failed to match the database
process's command-line path. The same running app then verified the installed
postmaster executable and its profile data directory, wrote a preference and
read it back. The combined observer stalled at its final check. An independent
HTTP request returned version `1.1.2834` from the real bundled worker. Quitting
from the tray produced a completed server shutdown and removed the postmaster
PID file.

For external PostgreSQL, the installed app connected to a separate loopback
cluster, which observed the live connection. The app read back its accepted
preference write and received the worker version. The observer passed before
the guest shut down. Its disk receipt matches the serial report, and the
stopped disk retains both native backend selections. The
[Windows acceptance record](security/rust-server-win32-x64-acceptance.json)
records these observations and the initial bundled observer failure.

## Windows x64 PostgreSQL packaging

On a clean Windows 11 x64 guest, the portable PostgreSQL 18.6 `pg_config.exe`
failed with `0xC0000135` and identified `VCRUNTIME140.dll` as missing. With the
x64 Visual C++ runtime DLLs alongside the PostgreSQL executables, the native
packager completed without a machine-wide runtime install. It also repaired
an existing build cache with missing DLLs. The exported `1.1.2834` archive
matched all 2,281 manifest entries, including the three runtime DLLs. The
standalone test initialized and started a fresh PostgreSQL cluster from those
packaged tools.

The same guest passed the Node `24.22.2` arithmetic and worker crypto import
controls. This run used a full x64 Windows guest under QEMU software
emulation. The standalone fixture now writes Windows paths with forward
slashes in its quoted dotenv values. With the corrected paths, the run reached
embedded PGlite initialization and timed out at the fixture's 60-second
deadline. A direct fresh-profile run with the same executable completed
migrations, returned HTTP 200 from `/readyz` after reaching the listen event
at 96.8 seconds, and shut down with exit code zero on stdin EOF.

After repeated Windows kernel crashes under QEMU's `max` CPU model, the same
guest completed the standalone suite under `Westmere-v1`. The fixture used a
240-second startup observation window. PGlite, bundled PostgreSQL and external
PostgreSQL all passed migration, SQL export, settings retention, hosted reopen
and supervision EOF. The test also verified the embedded runtime fallback,
Windows batch launchers, a server runtime PATH without Node and all 2,281
distribution file hashes.

The `1.1.2834` NSIS fixture installed successfully. The installed server matched
the standalone executable and its 2,281 manifest entries. The packaged worker
entrypoint and Node `24.22.2` also matched their expected artifacts. The
historical-profile test verified all 1,660 source files from the published Node
server before launch. The installed app reached legacy conversion and reported
failure before server readiness. The fresh-profile launch then failed while
`initdb` attempted to start the bundled PGlite `postgres.exe` through a
Windows extended-length path. The later installed-app checks above exercise
the repaired packaging and launcher.

### Worker helper packaging

The installed `cantrip.exe` and `cantrip-cua.exe` import
`VCRUNTIME140.dll`. The guest's Windows system directory and the installed
worker's `bin` directory lacked that DLL. Both installed version checks
failed. Byte-identical copies of the helpers printed their versions with
the Visual C++ runtime DLLs alongside them.

Windows x64 worker packaging now copies those DLLs beside the helpers. The
shared packager passed both executable version checks, repaired an incomplete
worker bundle, reused a complete bundle with the build toolset absent, and
populated an incomplete PostgreSQL cache before its actual `pg_config` call.

## Earlier `1.1.2833` package

The Windows x64 distribution from `81d9282a94833ba218fb4f2cb23b543c17a5530a`
passed PGlite, bundled PostgreSQL and external PostgreSQL on the local Windows
11 ARM64 guest running build 27754. All three modes retained identity and
accepted settings through restart, SQL export, hosted reopening and graceful
shutdown. The server ran with Node absent from its runtime PATH. The exported
archive independently matched all 2,278 file hashes.

The same packaged executable passed the embedded PGlite cache regression.
Concurrent fresh and retained profiles recovered missing assets, preserved an
accepted write and reused a complete cache. A truncated cache recovered, and
an explicitly configured incomplete directory reported the original
`initdb` error. The test also reopened markerless assets.

### Worker runtime controls

The published worker's 125 crypto modules matched their archived SHA-256
hashes. On this guest, official x64 Node `24.22.1` and `24.22.2` both
reported `Cannot find square root` during the NIST module import, with the
same result under `--jitless`. A standalone BigInt arithmetic program with
no imports exited with `0xC0000095` under x64 Node `24.22.2`. The same
arithmetic matched an independent Python calculation under native ARM64
Node `24.22.2`. [Microsoft NTSTATUS values](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-erref/596a1078-e883-4972-9bbc-49e60bebca55)

Both ARM64 Node 24 builds and x64 Node `22.23.4` imported the verified
modules. The x64 Node 22 arithmetic result also matched the Python control.
The current worker built from source enrolled when launched directly with
x64 Node 22 and answered its version command through the desktop-launched
Rust PGlite server.

### Desktop launcher recovery with the full worker

The console-free Windows launcher initially started the worker process, then
stalled before enrollment with the supervisor's stdin pipe inherited. A
matched control opened the worker's stdin as null and passed every store.
The shared Windows desktop worker launcher now opens stdin as null.

The production launcher source passes all three stores twice with the current
worker JavaScript and portable x64 Node `22.23.4`. Each case runs a real
worker version command, retains the server and worker identities and an
accepted preference, reaps the children on shutdown, and reopens the same
profile after supervisor loss. The fixture uses published Windows native
worker tools from `1.1.2397`. The separate installed-app checks above use the
packaged Node 24 runtime.

The packaging tests also execute the relocated Windows Node binary and check
its recorded version. All five focused Windows tests pass, including
termination of an actual three-generation process tree. The
[acceptance record](security/rust-server-win32-x64-acceptance.json) lists
the artifacts and reports for this refresh.

## Earlier `1.1.2819` package

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
remained open in this earlier run.

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
`rust-server-windows-worker-20261111-v1` and
`rust-server-current-windows-20261110-v1` in the local QA evidence directory.
The principal drivers are `packaged-server-acceptance.mjs`,
`desktop-runtime-acceptance.mjs` and
`desktop-profile-upgrade-compatibility.mjs` under `scripts/server-rust`.
The exported native distribution and guest profile/log archive accompany the
reports. Development validation ran locally.

The replacement qualification still covers remaining product and coordination
interruption cases, broader historical profiles and representative performance. The
[acceptance reconciliation](RUST_SERVER_ACCEPTANCE_RECONCILIATION.md)
tracks the current scope.
