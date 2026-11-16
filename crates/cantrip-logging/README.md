# cantrip-logging

Existing Cantrip service logging, extracted for use by the server and a future
Rust worker. This library has no server, database, HTTP runtime, or environment
configuration dependency.

- `logging`: structured calls, emitter, sampling, repeated-event summaries, and
  UTF-16 context handling. Supply the process name, clock, and output callback.
- `log_sanitize`: the existing text, URL, field, and error redaction boundary.
- `log_format`: service and HTTP-record console presentation. HTTP request
  instrumentation and route policy remain in the server.
- `log_records`: privacy minimization, bounded memory buffer, filtering, and
  cursor pagination. Persisted records retain less data than console output.
- `log_archive`: UTC daily parts, recovery, rotation, quota, compression,
  permissions, and retention. `Options::new` requires the source key, directory,
  and legacy filenames; limits and clock remain configurable.
- `runtime`: an instance owns its buffer, console handles, archive channel, and
  archive thread. Supply a console-level reader and explicit archive/color
  options. Separate instances share no capture or lifecycle state.

Initialize the runtime at the caller's startup point. Connect an `Emitter` using
`with_console_context` to `Runtime::capture_with_undefined`, or use `Emitter::new`
with another output. Stop producers and flush repeated summaries as required by
the caller, then await `Runtime::close()` to drain admitted records and join its
thread. This is an explicit lifecycle; dropping a handle is not a close receipt.
Records admitted to capture receive their buffer cursor and archive admission
under the same lock. The archive channel retains its existing serialized,
unbounded behavior; this extraction does not change overload policy.

The server adapter retains its singleton, process identity, environment lookup,
version/deployment messages, error classification, and startup/shutdown ordering.
A future worker supplies its own configuration and log streaming adapters.
The library does not install a global logger, read server environment variables,
or choose a server profile directory.

Host timezone/locale snapshot requirements are those of `cantrip-wire`. Existing
sanitization, privacy, archive, formatting, and lifecycle tests compare against
`packages/logging` and exercise the actual filesystem. The development archive
driver is built with `cargo build -p cantrip-logging --example log-archive-fixture`.
