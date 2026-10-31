# Cantrip native PGlite session access

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
