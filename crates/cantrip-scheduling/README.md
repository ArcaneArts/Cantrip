# cantrip-scheduling

Pure automation schedule calculations extracted from the Rust server. The server
uses this library for validation and occurrence calculation; dispatch, database
claims, and scheduling ownership remain in the server.

`first` and `next` accept an already validated Cantrip schedule value and a
millisecond timestamp. `timezone` and `cron_error` support protocol validation.
The implementation preserves interval, weekly, cron, one-shot date, legacy
timezone, and daylight-saving behavior. It uses `cantrip-wire` for JavaScript
date/value semantics and Jiff's bundled timezone database, without depending on
the protocol validator or server.

The existing occurrence test compares results with the unchanged TypeScript
schedule helpers. Legacy `SystemV/*` TZif assets are compiled into this library;
their development generator remains
`scripts/server-rust/project-automation-legacy-zones.mjs` at the repository root.
The Croner adaptation and its MIT license remain in `third-party/croner-compat`.

No timers, task dispatch, runtime initialization, or process supervision are
performed by this library. A future worker supplies its own scheduling lifecycle.
