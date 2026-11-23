# Cantrip native PGlite integration

Source: published `pglite-rs 0.2.7`, upstream commit
`14e9d2cbeeaf0aeb5b75c017046f40fc5b150fff`, `crates/pglite`,
https://github.com/Midwess/pglite-rs . MIT license is retained from that commit.
Native sys/runtime dependencies remain their existing locked crates.

Cantrip adds a scoped `WireSession` for offline native pg_dump. It holds the
existing transaction mutex without issuing BEGIN, allowing pg_dump to establish
its own snapshot and isolation level. Exchanges require mutable access. Dropping
the guard queues ROLLBACK before releasing the mutex, including cancellation.
This API is available only for the in-process backend: a process pool must pin a
connection before exposing a session. Existing SQL/transaction APIs are unchanged.

On Unix, native boot restores the embedding process's original SIGINT and
SIGTERM dispositions before reporting database readiness, including boot errors.
Otherwise host signal libraries chain PostgreSQL's backend handlers, interrupting
the database while the host is still draining shutdown work. Existing host
listeners survive boot. Other PostgreSQL signal dispositions are unchanged.

Windows runtime helper executables receive per-process UTF-8 manifests before
the matching runtime tar is embedded. Preparation uses portable PE/XML editing
at build time, including builds hosted on another operating system. This keeps
automatic extraction and explicit materialization consistent with packaged
runtime assets, without requiring PowerShell or a system code-page change when
the server starts. Existing helper resources and manifest settings are retained.
