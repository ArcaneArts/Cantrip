# cantrip-wire

Cantrip's existing JavaScript-compatible values, JSON, coercion, dates, and
canonical payload digests, extracted from the Rust server.

This library does not start services, read database configuration, or depend on
the server. `Value` retains nonfinite numbers and lone UTF-16 surrogates. Its
serialization and canonical digest ordering intentionally differ from ordinary
`serde_json::Value`.

`coercion::entries` exposes the existing ECMAScript object-entry ordering for
native consumers: array-index keys first, then other keys in insertion order.
It performs no serialization or value conversion.

`environment::timezone()` and `environment::locale()` share a process host
snapshot. Initialize it before embedding native software that changes process
locale or timezone, as the server already does before starting PGlite.

Use `value::json!` (or the root `json!`) to construct values without an intermediate
UTF-8-only JSON representation. Protocol validation belongs in the protocol
layer; this library supplies its value semantics.

The date parser includes code adapted from V8. Its upstream license is retained
in `V8-LICENSE`. The focused tests compare date behavior with the maintained Node
development reference and exercise bounded-stack JSON lifetimes and persisted
history digests. See `docs/RUST_SHARED_CRATES.md` at the repository root for the
extraction plan and validation scope.
