# Terminal architecture

Cantrip interactive and chat-console terminals are worker-owned PTYs rendered
by Xterm in the app. The PTY, its process generation, and its canonical
terminal state outlive any one visible React host. Browser navigation therefore
parks one of these live terminal surfaces instead of destroying it. A parked
surface keeps its Xterm instance, addons, stream, buffer, and input/output
sequencing, but is never fitted against a hidden or zero-sized container.
Restoring it performs a fit, Xterm refresh, link refresh, focus recovery, and
PTY dimension synchronization.

The browser retains at most 12 inactive interactive/chat-console surfaces.
Eviction is safe because a later renderer can recover from the worker's
canonical snapshot. Explicit close, worker identity replacement,
authenticated-session invalidation, owner removal, or retained-view replacement
tears down renderer ownership. A normal process exit writes the exit marker,
closes the attachment, and schedules reconnect; it does not synchronously
dispose the renderer. A linked console additionally closes its presentation
through `onExit`.

Run-configuration terminals are excluded from the retained-view registry. They
use `RunTerminalView` and bounded runtime-output polling rather than this parked
Xterm lifecycle.

## Canonical worker state

Every live PTY has a pinned `@xterm/headless` emulator and serializer on the
worker. PTY bytes enter that emulator in the same strict order in which they are
published to viewers. PTY resizes update it in the same mutation queue. A new
process generation resets its normal and alternate buffers, cursor, attributes,
modes, and bounded scrollback before new process output is accepted.

The canonical state understands cursor-addressed differential updates,
alternate-screen transitions, erase operations, color and attributes, Unicode
and wide characters, bracketed paste, mouse/application modes, and synchronized
output. Its normal-buffer scrollback is capped at 10,000 rows and a serialized
snapshot is capped at 2,000,000 UTF-16 characters. The serializer reduces only
old normal-buffer scrollback to meet the limit; it does not discard the active
screen. Raw PTY replay remains separately capped at 2,000,000 characters only
for mixed-version and degraded-state compatibility.

## Atomic attachment

An attachment registers its subscriber before requesting a snapshot. Snapshot
creation is inserted into the same worker queue as canonical writes and records
the exact process generation and output boundary. Bytes arriving after that
barrier are held in a bounded per-subscriber queue. The worker then sends:

1. one versioned, self-contained canonical snapshot, split into bounded and
   encrypted output frames;
2. every queued live delta after its recorded boundary exactly once and in
   order;
3. the ready marker.

Input remains disabled until the app has decrypted and written every hydration
chunk and queued delta. The app rejects overlapping, incomplete, out-of-order,
or stale same-generation hydration. Surface-stream operation IDs and monotonic
sequence numbers provide the outer attachment fence. Multiple viewers use
independent hydration queues over the same worker-owned PTY and canonical state.

The same terminal server frames travel over WorkerLink local, LAN/WAN, and relay
routes and the temporary direct endpoint. Snapshot bytes receive the same
end-to-end surface encryption as ordinary terminal output. Logs may contain
format/version, byte counts, chunk counts, dimensions, generations, boundaries,
latency, transport, and recovery status; they must never contain snapshot,
terminal-output, or input contents.

## Compatibility and recovery fallback

Hydration metadata is optional on the existing output frame. A new app accepts
an older worker's metadata-free replay, while an older app ignores the optional
metadata and continues consuming protected output. A new worker can therefore
run with older app or server components during a rolling update. The raw replay
path is explicitly identified as `legacy-raw-v1`, including whether it was
truncated; it is never called a complete snapshot.

If canonical serialization is unavailable and the raw replay is complete, the
worker can attach it without further recovery. If that raw replay is truncated,
the worker first registers the subscriber and requests one bounded redraw per
PTY process generation. It temporarily changes the PTY width by one column and
restores the real dimensions after 25 ms, producing ordinary `SIGWINCH` behavior
without injecting application keystrokes. All redraw output therefore reaches
the already-attached subscriber as live deltas. The generation fence and timer
prevent redraw loops, resize storms, or stale restoration after a process
restart. If even that resize cannot start, the app keeps the terminal usable but
shows a recoverable incomplete-display warning.

Applications are not required to repaint periodically. The resize fallback is
only a degraded compatibility path; normal reload and reconnect recovery always
uses the canonical snapshot.

## Operational events

The principal structured events are:

- worker: `terminal.snapshot.created`,
  `terminal.snapshot.legacy-selected`, `terminal.canonical-state.failed`,
  `terminal.recovery-redraw.requested`,
  `terminal.recovery-redraw.restored`, `terminal.recovery-redraw.failed`,
  `terminal.session.resized`, and `terminal.client.attached`;
- app: `surface.terminal.hydration.started`,
  `surface.terminal.hydration.completed`,
  `surface.terminal.hydration.failed`,
  `surface.terminal.parked`, `surface.terminal.restored`,
  `surface.terminal.reconnect-scheduled`, and `surface.terminal.closed`.

Repeated layout and failure paths use rate-limited logging. These events are
sufficient to distinguish parking from renderer recreation, transport
reconnection, canonical recovery, legacy fallback, process restart, and final
resource disposal without recording private terminal data.
