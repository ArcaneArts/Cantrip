# Cantrip CUA runtime

Worker-owned Rust computer-use library and executable. This cycle implements
the portable process/session/image/cursor core with an explicit deterministic
test backend. Native capture, worker/server/app integration, managed JavaScript,
permissions, and Trajectory are subsequent cycles in
[the CUA plan](../docs/planned/CUA.md). Nothing launches this crate from ordinary
Cantrip startup yet.

## Build and verify

```sh
cargo build --locked --manifest-path cantrip_cua/Cargo.toml
cargo build --locked --release --manifest-path cantrip_cua/Cargo.toml
cargo test --locked --manifest-path cantrip_cua/Cargo.toml
cargo fmt --manifest-path cantrip_cua/Cargo.toml -- --check
cargo clippy --locked --manifest-path cantrip_cua/Cargo.toml --all-targets -- -D warnings
```

The `process` integration tests launch the actual executable, send framed
requests, decode its PNG output, verify a configured crosshair at its logical
hotspot, and close the session/process. No permission or desktop content is
needed. Root `cua:*` and distribution integration belong to the next cycle.

Default execution advertises an unavailable native backend and returns a real
`unsupported` result for capture. `--backend fake` explicitly selects two fixture
targets; it is never an automatic fallback. `--version` is a standalone CLI
diagnostic, not the worker's capability handshake.

## Wire contract: version 1

The executable listens only on stdin and writes framed responses/events on
stdout. The worker is the future authorization boundary. It alone may authorize
and bind real tasks to this private child process; the Rust core does not
authenticate accounts or independently decide approval policy.

Each frame is:

```text
u32 big-endian JSON-header byte count
u32 big-endian binary-payload byte count
UTF-8 JSON header
raw encoded image bytes (when present)
```

Headers are bounded to 64 KiB; binary payloads to 16 MiB. Headers, versions,
message shapes, and payload eligibility are checked before payload allocation.
Only successful responses may have binary payloads. Requests carry no binary
data in this tranche. Zero-byte EOF before a frame is clean; a partial prefix,
header, or payload closes the invalid stream.

Header shape:

```json
{
  "version": 1,
  "message": {
    "kind": "request",
    "requestId": 1,
    "operation": { "operation": "capabilities.get" }
  }
}
```

`requestId` is a positive exact JavaScript integer, strictly increasing for new
requests on a connection. A `cancel` message's `requestId` references an existing
request; unknown or completed cancellations do nothing and do not poison a
future request. The other message kinds are `response` and `event`.

A response has `result: { status: "ok", data: ... }` or
`result: { status: "error", error: { code, message } }`. An event contains a
monotonic `sequence`, optional `sessionId`, and bounded event metadata. Events do
not duplicate images. JSON, pixels, target titles, and incoming identifiers are
never written to stderr; fatal process diagnostics contain only a fixed reason.

Keep stdin open while awaiting responses. EOF means the worker disconnected:
it cancels outstanding/queued work and shuts down, rather than committing a
batch after its owner vanished.

### Implemented operations

| Operation              | Fields beyond `operation`                                       |
| ---------------------- | --------------------------------------------------------------- |
| `capabilities.get`     | None                                                            |
| `targets.list`         | None                                                            |
| `target.attach`        | `binding`, `targetId`, `targetGeneration`                       |
| `target.detach`        | `binding`                                                       |
| `observation.snapshot` | `binding`, `targetId`, `targetGeneration`                       |
| `cursor.configure`     | `binding`, `targetId`, `targetGeneration`, `appearance`         |
| `cursor.move`          | `binding`, `targetId`, `targetGeneration`, `position: { x, y }` |
| `session.close`        | `binding`                                                       |

The binding contains `sessionId`, `workerId`, `chatId`, and optional `taskId`,
`threadId`, `turnId`. Existing session bindings must match exactly; a failed
lookup does not silently replace a session. The first successful `target.attach`
creates the session. A second observer attaching to the same target preserves
its shared cursor. A target switch retains appearance but resets geometry.

Target-bound operations specify **both ID and native generation**: different
windows may have the same generation. Snapshot verifies the target returned by
the actual capture, not a separate cached readiness guess. The backend returns
current geometry with its pixels; the core rejects target substitution. There
is no monitor fallback on window failure.

Snapshot data contains session/target/cursor state and image media type,
dimensions, encoded byte count, SHA-256, and `cursorIncluded: true`. PNG bytes
follow the header directly. Consumers must not render the baked-in cursor twice.
Later client/server integration must protect sensitive metadata and pixels
using Cantrip's existing endpoint encryption; private stdio is not itself that
network encryption layer.

## Bounds and cancellation

- One executor owns mutable sessions; an independent reader handles cancellation.
- At most 16 sessions, 256 inventory targets, and 32 pending requests.
- At most four queued outgoing frames, each with the bounded payload limit.
- The executor may wait up to two seconds for output capacity; the reader never
  blocks on that queue. Output overload closes the connection instead of growing
  memory without limit. Lost output cancels active native work immediately.
- EOF cancels current and queued work. Final output draining is bounded; the
  executable exits rather than keeping blocked I/O threads alive indefinitely.
- Accepted mutations check cancellation immediately before commit. Cancellation
  after commit does not relabel a successful mutation as uncommitted.
- Capture checks cancellation across backend, raster, composition, and encoding
  stages. Rendering/encoding process a bounded four-million-pixel image; no
  claim is made that an arbitrary native call can be interrupted by Rust alone.
- Image buffers use checked dimensions and an encoded-output bound. Native
  target dimensions may be larger than the bounded returned snapshot.

Malformed framing is terminal because guessing resynchronization could attach
bytes to the wrong request. An invalid operation produces a bounded error while
leaving a correctly framed connection usable. No retries, network listeners,
input injection, native permission checks, or automatic task authorization are
implemented here.

## Cursor contract: appearance version 1

```json
{
  "version": 1,
  "style": "crosshair",
  "color": "#20BFA9FF",
  "size": 24,
  "label": "Agent",
  "trail": true,
  "visible": true
}
```

- Styles: arrow, dot, ring, crosshair.
- Color: `#RRGGBB` or `#RRGGBBAA`.
- Size: 8–96 target-local logical units.
- Optional label: at most 64 Unicode scalar values and 256 UTF-8 bytes; no
  control characters. No HTML, SVG, external URL, or custom image is interpreted.
- Trail: at most 24 previous points; disabling it clears the trail.
- Arrow hotspot: upper-left tip. Other styles: center.
- Position is target-local, finite, and inside the attached target. Negative
  global monitor origins do not shift it. X/Y pixel scale is derived separately.
- Appearance and movement update cursor revision/timestamp without touching the
  OS pointer. Resize removes invalid trail geometry before rendering.

The first renderer uses a deterministic embedded bitmap font, supporting its
Latin, Greek, Hiragana, and symbol tables. Unsupported glyphs use a visible
replacement box; full shaping, emoji, combining marks, and bidi layout remain
explicit typography limitations, not claims of full Unicode rendering.

The generic core builds on non-macOS targets. Cross-checking a Windows target
is not evidence of running Windows native capture or a Windows executable;
that backend remains unavailable.
