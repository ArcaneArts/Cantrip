# Current Windows native server qualification

## Windows x64 1.1.3059 package verification

The Windows 11 x64 guest packaged the Rust executable from `86dc1f0a1`.
The host matched all 2,281 archive files to its manifest and matched the
server executable to the desktop NSIS payload. The installer verifier
matched all 14,092 app and runtime files and verified its QA updater
signature. The installed executable differs from the cross-built shell
only by Tauri's NSIS bundle marker. The installer carries the previously
verified 1.1.2976 worker assets. Release Authenticode remains open.

The initial standalone run ended during the PGlite connection at the
driver's 60-second deadline. Its guest script reported a longer budget
without passing it to the driver. The driver now accepts an explicit
deadline and reports the time to readiness. The updated driver passed
the relocated macOS ARM64 1.1.3059 archive on all three stores. The Windows
retry passed PGlite and reached bundled PostgreSQL. The first bundled
launch and migration completed, and the SQL export through `migrate.cmd`
failed in `pg_dump`. Two follow-up calls to the same Rust executable on the
same profile produced identical SQL, including a direct call to the bundled
`pg_dump`. The full launcher matrix and signed updater remain open.
[Archive, installer and harness verification](security/rust-server-3059-windows-package-verification.json)
[Windows launcher retry and export controls](security/rust-server-3059-windows-standalone-retry.json)

Fresh and reopened installed PGlite cases passed in the same guest. The desktop
launched its Rust server, saved and read back a setting, and received a
version reply from its packaged 1.1.2976 worker. Reopening used the stored
database selection and retained the server identity and setting. Both tray
quits exited zero, reaped both children and recorded an orderly server
shutdown. Fresh PGlite startup took 216.657 seconds under x64 emulation.
Both guest disk receipts match the serial output.
[Installed PGlite cases](security/rust-server-3059-windows-installed-pglite.json)

Fresh and reopened bundled PostgreSQL cases passed on the same installed
package. Both quits drained the app's Rust server and Node worker and stopped
the private PostgreSQL process. The reopened profile retained the setting and
server identity from the first case. The two guest disk receipts match the
serial observations.

Fresh and reopened external PostgreSQL cases passed as well. PostgreSQL
observed a connection from the app's Rust server and remained running after
each tray quit. The second launch used the stored database configuration
and retained the original server identity and setting. The guest disk
receipts match all six first-launch and reopen observations.
[Installed desktop cases](security/rust-server-3059-windows-installed-desktop.json)

### Installer with the current Node worker

A second NSIS package uses the worker and workspace packages built from
`86dc1f0a1`. Its 19 direct third-party dependency resolutions and three
patch hashes match the prior Windows payload. The verifier checked 14,085
app and runtime files and the QA updater signature. The app and Rust server
digests match the first installer, and all 18 payload differences are in
the worker directory. The guest runtime matrix and release Authenticode
verification remain open.
[Current-worker package verification](security/rust-server-3059-windows-current-worker-package.json)

## Windows x64 standalone `1.1.2938`

The standalone server from `5015c89a4` passed PGlite, bundled PostgreSQL,
and external PostgreSQL in the local Windows 11 x64 guest. Each store ran
migrations, exported SQL, retained its server identity and saved setting
across local and hosted reopening, and shut down through supervision
stdin close. Windows launcher encoding and embedded PGlite recovery
passed. The server runtime PATH excluded Node.

The default 60-second harness deadline expired during the initial PGlite
connection. The retry used the previously qualified 240-second guest
deadline, with the same functional assertions and 15-second shutdown
deadline. First readiness in the emulated guest took 101 seconds for
PGlite, 118 seconds for bundled PostgreSQL, and 27 seconds for external
PostgreSQL. The host independently matched all 2,281 archive files and the
three SQL export digests to the guest receipts.
[Windows x64 standalone record](security/rust-server-2938-win32-x64-standalone.json)

## Windows x64 desktop rebuild at `9e2dd5711`

The `1.1.2881` desktop updater rejected a tampered download and installed
the verified QA-signed package over `1.1.2869`. The app, Rust server, and
packaged worker all reported the updated version. The retained PGlite
profile kept its server identity, enrolled worker, and written setting.
Tray quit exited zero, recorded the server's orderly shutdown, and reaped
both child services. Both guest exports matched their reported hashes and
the serial observations.

The same installed package passed first launch and persisted-profile
reopening on PGlite, bundled PostgreSQL, and external PostgreSQL. Every
case received a real worker version reply and shut down through the tray.
Each reopened profile retained its identity, selected backend, and saved
setting. Bundled PostgreSQL stopped with the app, and external PostgreSQL
continued running after app shutdown. A read-only guest disk snapshot matched
all six serial receipts and all 14,092 installed payload files.

The run used a Windows 11 x64 QEMU guest on macOS ARM64. The installer used a
disposable QA updater signature. Release Authenticode verification remains
open. The initial guest shutdown before the update is retained in the
record alongside the completed retry.
[Windows x64 rebuild evidence](security/rust-server-2881-win32-x64-desktop.json#replicaRepairRebuild)

## Windows x64 rebuild at `01928fcff`

The `1.1.2881` Windows standalone archive matched all 2,281 manifest files
and passed PGlite, bundled PostgreSQL, and external PostgreSQL. Each mode
ran migrations, exported SQL, retained its server identity and setting
across restart and hosted reopening, and exited on supervision stdin close
within the existing 15-second limit. The disk receipts matched the guest
serial output and each SQL export matched its receipt.
[Windows x64 standalone rebuild](security/rust-server-2881-win32-x64-standalone.json#workspaceRemovalRebuild)

The corresponding NSIS bundle matched all 14,092 payload files. It contains
the same Rust executable as the standalone archive and its QA updater
signature verified. Fresh and reopened profiles passed for all three stores.
Each pair retained its server identity and accepted setting, received a
packaged worker reply and shut down cleanly. The bundled database stopped
with Cantrip. External PostgreSQL stayed running after the app quit.
The guest shut down during the first external run when its evaluation
license expired. The retry used a separate profile and passed both cases.
All six guest disk receipts match the serial observations.

The signed updater rejected a tampered package, installed the verified
payload and retained the PGlite profile. The updated app owned the expected
server and worker. A guest disk snapshot shows the server completed its
shutdown and a separate process observation shows both children exited.
The PowerShell fixture's final receipt is still missing.
[Windows x64 desktop rebuild](security/rust-server-2881-win32-x64-desktop.json#workspaceRemovalRebuild)

The standalone server and packaged worker passed queued Task provider
transfer on all three stores. Each test persisted the transfer at revision
3 and fence 9 while the worker was offline. The replacement worker reused
its enrollment, settled the original encrypted input at revision 4, and
preserved the result across shutdown. The disk reports matched guest serial.

The first driver attempted to invoke `rustc` inside the guest. A second
attempt enrolled the worker and reached the exit check. The fixture then
counted the post-exit Windows process query against the 30-second exit
timer. The corrected fixture verified all six worker exits inside that
deadline and confirmed that every observed descendant was gone.
[Windows Task transfer record](security/rust-server-task-inference-route-acceptance.json#rebuiltWindowsArtifact)

The same executable passed a deterministic Task route read on external
PostgreSQL. The test observed the HTTP query waiting on a real database
lock, then committed the phase and revision together. Both the waiting
read and a subsequent read returned completed at revision 4. The guest
disk report matched serial, and the server shut down cleanly.
[Windows settlement read](security/rust-server-task-inference-route-acceptance.json#currentWindowsSettlementRead)

With the same server and worker, the existing browser received HTTP 409
with `stale-lease` while a real Task dispatch awaited its model response.
The rejection left the durable revision and fence unchanged and kept the
provider route hidden. The original Task finished after the response was
released, and the browser decrypted its answer. Guest disk and serial
receipts match. The Rust server shut down cleanly, and the Windows
teardown verified that the eight observed worker processes exited.
[Windows active dispatch](security/rust-server-task-inference-route-acceptance.json#currentWindowsActiveDispatch)

## Windows x64 standalone `1.1.2881`

The Windows 11 x64 QEMU guest packaged the `1.1.2881` Rust executable and
verified 2,281 files. PGlite, bundled PostgreSQL, and external PostgreSQL
each passed migration, SQL export, saved-setting and identity continuity,
hosted reopening, and supervision through stdin close. Embedded PGlite
runtime recovery and Windows launcher encoding passed. The server ran
with a runtime PATH free of Node.

The native packager completed before the original transfer failed. A
replacement transfer disk recovered the archive. The evaluation guest
shut down during an earlier standalone attempt. The completed rerun used
the same verified package, and the host matched both receipts to the
guest serial output.
The package rebuilt at `ff6a4b060` matched all 2,281 manifest files after
transfer from the same Windows guest. The server executable is the only
changed package member. The first standalone attempt with the rebuilt
package timed out during PGlite startup after 240 seconds. The earlier
three-store result still applies to its recorded executable.
[Windows 1.1.2881 standalone record](security/rust-server-2881-win32-x64-standalone.json)

The Windows build now passes `NUL` to the embedded PGlite runtime when it
redirects standard input. The Windows CRT probe returned end of file for
`NUL` and error 2 for `/dev/null`. The patched `1.1.2881` executable
started directly with a fresh PGlite profile, saved a setting, reopened
with the same identity and setting, and exited zero on supervision stdin
close both times in the Windows 11 x64 guest.
[Windows PGlite runtime record](security/rust-server-2881-win32-x64-standalone.json#rebuiltPackage)

The Windows guest packaged that executable and the host independently
matched all 2,281 files. The rebuilt archive passed the PGlite standalone
case, including migration, SQL export, settings, restart, hosted reopening,
and stdin-close shutdown. The bundled PostgreSQL case reached readiness and
exceeded the suite's 15-second shutdown deadline. The external PostgreSQL
case remained unrun in that attempt.
[Patched Windows standalone record](security/rust-server-2881-win32-x64-standalone.json#patchedStandalonePackage)

The patched NSIS installer matched all 14,092 staged files. Its changes
relative to the previous installer were the Rust server executable and its
manifest. The local QA updater signature verified.

The installed app from this patched NSIS package passed first start and
persisted-profile reopen on PGlite, bundled PostgreSQL, and external
PostgreSQL. Each pair retained the server identity and the setting written on
first start. All six launches received a reply from the bundled worker and
quit through the native tray, with a completed Rust shutdown and both child
processes reaped. Bundled PostgreSQL stopped with the app. External
PostgreSQL observed the app connection and remained running after app shutdown.

A read-only NTFS snapshot independently matched all 14,092 installed files
to the installer manifest. All six disk receipts match the guest serial.
The evaluation guest shut down after bundled PostgreSQL first start, and
the test resumed from the same disk. The external PostgreSQL first-start
observer resumed tray confirmation on the same app process.

The signed update retry reused the initialized `1.1.2869` PGlite profile.
The app and worker were observed before the update, and the updater
rejected the modified download. Windows shut down while the valid package
was installing. The guest disk matched the new app and server hashes and
still held the previous worker. Signed-update relaunch and profile retention
for this installer remain open.
[Patched Windows installer record](security/rust-server-2881-win32-x64-desktop.json#patchedInstaller)

## Windows x64 rebuilt desktop installer

The rebuilt NSIS installer contains the Rust server from `ff6a4b060` and
the desktop shell from `2dcc69ed8`. All 14,092 installer entries matched
the staged payload. The 11,807 worker, Node and profile converter files
match the previous installer byte for byte. The QA updater signature
verified. Installation, database startup and signed update remain open
for this installer.
[Windows x64 desktop record](security/rust-server-2881-win32-x64-desktop.json)

## Windows x64 installed database modes on `1.1.2881`

The rebuilt NSIS installer passed first start and reopening on PGlite,
bundled PostgreSQL, and external PostgreSQL in the Windows 11 x64 guest.
A read-only disk snapshot matched all 14,092 files to the installer.
The first starts completed anonymous recovery setup and wrote a setting.
Each reopen read back the same setting and server identity using its
persisted database selection.

Each run received a reply from the bundled Node worker, exited zero
through the native tray, reaped the worker and Rust server, and logged
orderly Rust shutdown. Managed PostgreSQL stopped with the app.
External PostgreSQL observed the app connection and stayed running
after app shutdown. The independent disk receipts matched the guest
serial output for all six runs.

The previous package gave up while PGlite was still running migrations
under QEMU software emulation. The rebuilt desktop supervisor allowed
those migrations to finish. The installer carries a disposable QA
updater signature. The signed in-place upgrade to this exact installer
has separate acceptance.
[Windows 1.1.2881 installed desktop record](security/rust-server-2881-win32-x64-desktop.json)

## Windows x64 standalone `1.1.2869`

The Windows 11 x64 QEMU guest packaged the Rust server from
`0ae86163efb8503387a2b3d627f9e962d099e1cd` with PostgreSQL 18.6 and the
bundled Visual C++ runtime. The relocated package passed PGlite, bundled
PostgreSQL, and external PostgreSQL. The tests ran migrations, matched
each SQL export to its runtime receipt, retained settings and identity
across restart and hosted reopening, and shut down when supervision stdin
closed. They verified 2,281 files, the Windows launchers, configuration
precedence, and embedded PGlite fallback. The server's runtime PATH had
no Node executable.

The native packager exited zero. Its transfer disk filled while copying
the archive, which was recovered from a read-only guest snapshot. The
archive and verified manifest matched the guest executable and the
standalone suite's serial and disk receipts. The guest used a 240-second
readiness observation window for software emulation.
[Windows x64 acceptance record](security/rust-server-2869-win32-x64-acceptance.json)

## Windows x64 signed update to `1.1.2869`

The installed `1.1.2845` app rejected an altered installer with
`update_signature_invalid` and installed `1.1.2869` through its updater
over loopback HTTPS using a disposable QA updater key. A read-only
guest snapshot matched 14,089 installed files to the signed NSIS payload.

The original observer failed on an uninitialized variable after
requesting installation. Fresh WebView and HTTP probes on the same
relaunched app verified that the app, Rust server, and bundled worker
each reported `1.1.2869`. The PGlite profile retained its server
identity, worker identity, and saved theme. The updated app exited zero
through its tray, reaped the Rust server and worker, and logged a
completed server shutdown.
On a subsequent launch, the same installed app reopened the retained
profile using its persisted PGlite selection, read back the theme,
received a worker reply, and shut down again through the tray.
The Windows evaluation guest later shut down at its license deadline.
The retained-profile receipt was recovered from the guest disk.
[Windows x64 signed update record](security/rust-server-2869-win32-x64-acceptance.json#signedUpdate)

## Windows x64 installed database modes on `1.1.2869`

The installed app passed first start and reopening on PGlite, bundled
PostgreSQL, and external PostgreSQL. Each first start completed anonymous
recovery setup and wrote a setting. Each reopen selected its database from
the stored profile with database environment overrides cleared and
read back the same setting and server identity.

The three first starts, three reopens, and signed-update profile reopen
each received an actual reply from the packaged worker, exited zero
through the tray, reaped the server and worker, and logged a completed
Rust server shutdown. The bundled postmaster exited and its PID file
was removed on shutdown. The external PostgreSQL fixture observed an app
connection and remained running after app shutdown.
[Windows x64 installed matrix](security/rust-server-2869-win32-x64-acceptance.json#installedMatrix)

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

## Windows x64 installed `1.1.2845`

The installed `1.1.2841` app updated through the real Cantrip updater over
loopback HTTPS. The updater rejected a modified installer with
`update_signature_invalid`, then accepted the NSIS installer signed with the
disposable QA updater key. The relaunched app, native server and packaged
worker each reported `1.1.2845`. The original PGlite profile kept its server
identity, worker identity and written theme.

An independent Windows disk read matched all 14,090 installed files to the
signed installer payload, including the Rust executable from the standalone
qualification. Tauri patches the desktop executable while assembling NSIS.
The first observer compared it with the pre-packaging hash. The retained
record includes that assertion and the matching installed payload hash.

The signed-update profile reopened after the guest restarted, retained the
same identity and setting, and received a worker reply. The installed app
also passed first start, a settings write, restart and readback on all three
database modes. Each of those six runs and the signed profile reopen used the
app's tray confirmation, exited zero, reaped both service processes and logged
a graceful Rust server shutdown.

The bundled PostgreSQL postmaster ran from the packaged executable and
exited with the app. External PostgreSQL stayed up after app shutdown until
the fixture stopped it. Both PostgreSQL modes reopened using their stored
profile settings with database environment overrides removed. The worker
answered an actual version command on every run.

The Windows 11 x64 guest ran with QEMU software emulation. The independent
receipt observer verifies the live Rust child listener through Windows.
PowerShell attached filesystem-provider metadata to a line read from the
postmaster PID file. The corrected receipt records the independently
verified data directory as a plain string, allowing the same running app
to finish its observation and subsequent reopen.
[Current installed acceptance record](security/rust-server-win32-x64-acceptance.json#currentInstalledDesktop)

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

## Windows x64 signed update to `1.1.2976`

The installed NSIS app updated from `1.1.2938` over a local HTTPS fixture.
The updater rejected the modified installer and preserved the baseline
binary. It then installed the signed copy and relaunched with the retained
PGlite profile, server identity, worker enrollment and setting written
before the update. The installed executable hashes matched the package
inputs. Tray quit returned zero, reaped the worker and Rust server, and
recorded a complete server shutdown. The guest disk receipts matched the
serial transcript. The test ran in the local Windows x64 QEMU guest using
a disposable updater key and HTTPS root.
[Windows 1.1.2976 signed update evidence](security/rust-server-2976-win32-x64-packages.json#signedUpdate)

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
