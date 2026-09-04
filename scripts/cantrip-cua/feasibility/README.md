# CUA tranche-one feasibility

These opt-in probes are not installed, packaged, or launched by Cantrip. They
establish the native and evaluator choices for the implementation ledger in
[CUA.md](../../../docs/planned/CUA.md). No production CUA capability exists
yet. Generated executables and logs stay in the ignored `target/` directories.

## Native fixture and signing

On an interactive macOS 14+ machine with the Xcode command-line tools:

```sh
CANTRIP_CUA_PROBE_SIGNING_IDENTITY='Apple Development: YOUR CERTIFICATE NAME' \
  node scripts/cantrip-cua/feasibility/native.mjs
```

Use an existing authorized signing identity; do not put a password in this
variable. Without the variable the probe runs the actual capture but reports
signed identity continuity as unverified. It does not reset privacy permissions
or try another identity after denial.

The fixture creates a red window and an identical blue covering window. It
checks native front-to-back ordering, captures the red window using a
desktop-independent ScreenCaptureKit window filter, and verifies decoded center
pixels are red. It never captures another application's window, persists an
image, activates another application, or injects input. Both windows close on
exit. A 20-second independent watchdog bounds capture; the outer runner also
bounds a hung child.

The runner compiles unoptimized and optimized variants to the same fixture
path. With an explicit certificate it signs both as
`art.cantrip.cua.feasibility`, verifies the signatures, compares designated
requirements, and asserts the executable bytes differ. It launches each build
and requires a real successful pixel assertion. This is a signing experiment,
not the installed product helper path or production identity.

Observe:

1. A blue rectangle briefly covers the red fixture.
2. Each run prints a passing `occluded-capture` checkpoint.
3. The final `signed-rebuild` checkpoint passes with a certificate, or warns
   that signing continuity was not checked without one.
4. The fixture leaves no windows running. Record whether macOS prompted again
   on the second run; automated success alone does not establish prompt history.

Return `scripts/cantrip-cua/feasibility/target/native-probe.log` and observations
of unexpected prompts or visible fixture behavior. It contains bounded fixture
checkpoints, not private window titles or screenshots. A denied actual capture
reports the native error; approve only through the normal macOS permission UI
if desired, then rerun deliberately.

### Observed on 2026-09-04

- macOS 27.0 (26A5421a), arm64; Swift 6.3; Rust 1.93.
- The first Swift prototype mixed an unserviced task with `NSApplication.run`
  and stalled. An async main entry point with an independent deadline fixed
  the harness. This was a fixture scheduling failure, not a capture denial.
- Native occluded-window capture passed: 256 × 192 pixels, 122 ms on the first
  successful run, then 129 ms and 133 ms for the two-build signing experiment.
  The final formatted-source rerun also passed at 126 ms and 137 ms.
- Apple Development signatures verified; the two distinct builds had equal
  designated requirements and both captured the fixture successfully.
- A separate Developer ID-signed, timestamped hardened-runtime fixture passed
  strict signature verification. It was not used to claim packaged capture or
  permission reuse.
- Parent application attribution, installed helper behavior across worktrees,
  and packaged Tauri updates remain unverified and required in later cycles.

Stable privacy identity needs a stable signing requirement, not just a fixed
path. Ad-hoc signatures do not establish continuity across changed executable
bytes. Development and Developer ID channels have different requirements and
must be verified separately. Keep the platform-generated requirement rather
than hand-writing a broad one. See
[Apple TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

## Native binding decision

Use narrowly enabled `objc2-screen-capture-kit` bindings with `objc2`, `block2`,
Foundation, and CoreGraphics for the production Rust backend. They expose the
same native calls exercised here without bringing in the broader existing
Remote Desktop package or an additional Swift runtime bridge crate.

The initial snapshot implementation will use `SCScreenshotManager` on macOS
14+. Older OS versions should report CUA capture unavailable; do not raise the
whole application's minimum OS version. Native handles and callback ownership
stay in a small Rust platform module. A first-frame `SCStream` path for older
systems is a future extension, not a silent monitor fallback. See
[SCScreenshotManager](https://developer.apple.com/documentation/screencapturekit/scscreenshotmanager)
and the [focused bindings](https://docs.rs/objc2-screen-capture-kit/0.3.2/objc2_screen_capture_kit/).

## JavaScript decision

The [standalone Rust probe](javascript/README.md) selects `rquickjs` 0.12.2,
with no host I/O or module loader. All five tests, formatting, Clippy with denied
warnings, and the release executable pass. Release samples here: persistent
global/host call 754 µs; ambient I/O rejection 289 µs; deadline interruption
25,178 µs; heap-limit rejection 178 µs; runtime disposal/reset 251 µs.

These are probe measurements, not production performance budgets or proof of a
complete sandbox. Later implementation must bound host calls, native image
memory, cancellation, promise jobs, action count, and result output separately.

## Repository integration findings

| Boundary                      | Existing seam                                                                | Required integration                                                                                                  |
| ----------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Chat/worker authority         | Server `getChatExecutionContext(ownerId, chatId)` and worker command bus     | Derive worker from owned execution context; dedicated CUA command/route                                               |
| Worker process                | `cantrip_worker/src/index.ts` service setup/dispatch/shutdown                | One lazy service; constructor must not launch native capture                                                          |
| Private observation transport | `packages/crypto/src/endpoint-content.ts`                                    | Protect bounded metadata + binary image using existing byte encryption and CUA-specific authenticated operation/scope |
| Server blindness              | Existing protected endpoint-content routing                                  | Server relays ciphertext; no screenshot decoder or native-session tables                                              |
| Agent tools                   | `cantrip_worker/src/mcp/{managed,broker,connection,stdio}.ts`                | Dedicated managed host through authenticated broker; never another sidecar owner                                      |
| Approvals                     | Existing encrypted durable agent interactions                                | Add a worker-owned CUA response resolver; ordinary Codex RPC promises cannot resolve CUA approvals                    |
| Trajectory                    | Protected chat/task event sealers                                            | Preserve attribution for both agent and idle client-preview actions; no second screenshot store                       |
| Packaging                     | `scripts/package-distributions.mjs` worker `bin` and inherited Tauri runtime | Build/copy sidecar and run actual packaged handshake                                                                  |
| macOS identity                | `scripts/sign-macos-runtime.mjs`, `verify-macos-distribution.mjs`            | Explicit stable helper identifier, nested signing, final-layout handshake and identity verification                   |

Important implementation traps established by inspection:

- Endpoint crypto already accepts bytes and authenticates owner, server,
  worker, scope, operation, direction, sequence, and key revision. Existing app
  and worker wrappers are JSON-only: add bounded byte-envelope wrappers, not
  screenshot base64 inside native IPC JSON. Ciphertext encoding at the existing
  relay boundary is distinct from plaintext screenshot encoding.
- Broker request/results are closed unions. Add an explicit image-result path
  and convert bytes to MCP `ImageContent` only at the tool boundary.
- Durable interactions currently resolve Codex-owned pending requests. CUA
  needs its own cancellation-aware resolver before a reply is forwarded to
  Codex. Merely emitting an approval would leave it pending forever.
- Activity emitters are currently turn-scoped. Preview operations on an idle
  chat still need the existing protected publication path, not a separate log.
- Keep the current Remote Desktop dependencies in place: this tranche does
  not establish parity for their input/capture behavior.

These findings are implementation requirements, not claims those integrations
already exist. No client, server, worker, build, release, or startup code changes
in this cycle.
