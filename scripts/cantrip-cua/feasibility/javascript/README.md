# CUA JavaScript feasibility probe

This standalone cycle-one experiment tests `rquickjs` 0.12.2 as the embedded
JavaScript engine for the future `cantrip-cua` sidecar. It is not linked into
Cantrip or launched by development or production startup.

From the repository root:

```sh
cargo test --locked --manifest-path scripts/cantrip-cua/feasibility/javascript/Cargo.toml
cargo run --locked --release --manifest-path scripts/cantrip-cua/feasibility/javascript/Cargo.toml
```

The executable prints only named pass/fail results and elapsed microseconds.
It proves:

- A context retains globals across evaluations and calls one explicitly
  registered bounded Rust function.
- Node, browser, QuickJS CLI, timer, and worker host APIs are absent. Constructor
  evaluation does not reveal them. Imports of `std`, `os`, `node:fs`, and a local
  file reject without installing a module loader.
- The interrupt handler ends an infinite loop at a 25 ms deadline, within a
  2 second scheduling tolerance, and a later evaluation remains usable.
- An 8 MiB engine heap limit rejects a 64 MiB `ArrayBuffer`, while small
  allocations still succeed afterward.
- Dropping and recreating the entire runtime discards globals and queued
  promise jobs while recreating the allowed host binding.

The Cargo dependency enables only `std`, which is Rust standard-library support.
It does not enable `loader`, `dyn-load`, `futures`, `rust-alloc`, or a custom
allocator. The latter distinction matters because rquickjs documents the
built-in memory limit as ineffective with custom allocators.

These results establish feasibility, not a complete production sandbox. A
production evaluator still needs source/output/action/snapshot limits, a bounded
promise-job pump, external cancellation, permission-scoped CUA host functions,
and separate session runtimes. The heap limit covers engine allocations, not
Rust host allocations or image payloads. Engine interruption cannot interrupt a
blocking native host function; those functions need their own cancellation and
deadline handling. The sidecar process must remain disposable for engine faults.

References:

- [rquickjs crate and feature documentation](https://docs.rs/rquickjs/0.12.2/rquickjs/)
- [Runtime interrupt and memory controls](https://docs.rs/rquickjs/0.12.2/rquickjs/struct.Runtime.html)
- [Context lifecycle](https://docs.rs/rquickjs/0.12.2/rquickjs/struct.Context.html)
