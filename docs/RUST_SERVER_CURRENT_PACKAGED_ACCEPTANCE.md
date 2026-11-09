# Current native package qualification

The full server replacement remains incomplete. Node remains the default server
and the worker remains Node. This milestone fixes Windows native packaging and
refreshes scoped local artifact and desktop-supervisor qualification.

## Actual Windows failures and repairs

The x64 GNU release build originally failed to link native PGlite's zlib imports.
The server now links a static Windows zlib build without an installed MinGW zlib
library or an additional runtime zlib DLL.

Actual Windows execution then exposed PostgreSQL tools losing characters outside
the system ANSI code page. An emoji profile path failed during `initdb`. Windows
server builds now include a per-process UTF-8 manifest; the packager applies that
setting to its copied PostgreSQL and PGlite tools before hashing the artifact.
Existing manifest settings, language variants and unrelated resources are kept.
No machine-wide locale or code-page setting changes.

The embedded-runtime fallback independently reproduced the same failure. PGlite
runtime helpers now receive matching manifests before their tar is embedded,
using portable build-time PE/XML editing that also works during cross builds.
An initial repair updated only the English manifest; actual resource inspection
found the neutral variant still lacked UTF-8, while the working packaged helper
had both variants updated. The final repair updates every existing variant.
Direct execution of the corrected embedded `initdb` and the complete final
embedded-runtime fallback both pass with emoji paths. Startup needs no resource
editor, PowerShell, JavaScript database helper or system locale adjustment.

The packaged acceptance driver now runs real Windows `.cmd` launchers and `.exe`
tools. It closes the supervision pipe for graceful Windows shutdown, preserves
strict Unix SIGTERM assertions, and avoids inherited daemon pipes in the external
PostgreSQL test fixture. Negative path tests accept the actual Windows OS error
wording. A separate correction checks portable remembered backend selection
without assuming an installation-specific distribution fallback was persisted;
explicit user-selected PostgreSQL binary paths retain their original assertions.

## Candidate evidence

All development validation ran locally. Candidate version is `1.1.2777`.
The macOS artifact was built from `bbddb0e538e5eeb58cd7d61d2d65bf4fa1727db9`
before this Windows-specific repair. The Windows candidate includes this
milestone's working-tree changes on that base. These candidates are not a claim
about a subsequent release build or final integrated replacement acceptance.

| Candidate                                                                 | Actual qualification                                                                                                                                                                                                                                                   | Result |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| macOS arm64 optimized server distribution, private PostgreSQL 18.6        | PGlite/private PostgreSQL/external PostgreSQL; local and hosted; migrations, SQL exports, retained identity/settings/restart, strict SIGTERM; 1,762 file hashes; Homebrew reads and artifact writes denied; runtime PATH without Node                                  | Passed |
| Windows x64 optimized server distribution, private PostgreSQL 18.6        | All three stores, local and hosted; real batch launchers, migrations/exports/restart, retained identity/settings and configuration precedence; graceful supervision EOF; 2,278 file hashes; emoji and space paths; native embedded fallback; runtime PATH without Node | Passed |
| Current macOS production desktop supervisor with the packaged Node worker | All three stores; real worker command and retained worker/server identity; settings/restart; supervisor SIGKILL and reopening; clean shutdown and child reaping                                                                                                        | Passed |

Windows execution used Windows 11 build 27754 ARM64 with x64 emulation in an owned
local VM clone. This is actual Windows-kernel artifact execution, not bare-metal
x64 performance or complete Windows desktop-app qualification. The user's
original VM remained stopped and unchanged.

The final raw Windows executable is 110,905,489 bytes, SHA256:

```text
f56aaec6de6f97ff6ca0985d00d711d63aadeb5eada1f676dddbb4c354ba36fc
```

The PE resource test exercises two existing manifest languages, execution
privileges, a long-path declaration, assembly identity and unrelated opaque
resource bytes. All are preserved; repeating the update leaves the executable
hash unchanged. The final optimized Windows artifact passes the complete
relocated-distribution driver rather than a substituted HTTP fixture binary.

Reports are retained under the owned milestone QA roots. Relevant report names
are `macos-package-acceptance-v4.json`, `desktop-runtime-acceptance-v1.json`,
`windows-package-acceptance-v10.json` and `guest-manifest-resource-tests-v2.log`.
Earlier failed reports, exact source, executable bytes and guest test evidence
remain part of the milestone evidence; they are not overwritten by the passing
results.

The final source passes all 83 Rust library tests, strict all-target macOS
Clippy, strict Windows library/binary Clippy, 24 packaging/workflow Node tests,
Rust formatting and scoped JavaScript/Markdown formatting.

## Remaining replacement acceptance

Current Linux/container/Winterhold and complete desktop app/update artifacts,
broader historical profiles and product post-write rollback, remaining product
and interruption behavior, representative performance, final Rust-default
selection and production Node-server removal remain required. Earlier desktop
upgrade and Winterhold implementations have their own scoped qualification;
they are not unimplemented. See the
[acceptance reconciliation](RUST_SERVER_ACCEPTANCE_RECONCILIATION.md).

No production Winterhold deployment or GitHub Actions development run was
performed. The existing all-target Windows Clippy check reports an unused
`desktop_path` function in the shared desktop probe source; focused Windows
library/binary strict Clippy passes. The standard `pnpm check` still stops at
unchanged Node line budgets: `build-app.ts` 1,539/1,500 and
`chat-turn-runtime.ts` 2,329/1,999. Later aggregate checks are not claimed as
passing.
