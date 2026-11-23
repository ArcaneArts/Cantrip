# Node worker reference

The retired TypeScript worker provides compatibility evidence for the Rust
worker. Its source, dependencies, and the historical guest helpers live
here for explicit development comparisons. Normal builds and packages use
`cantrip_worker`.

From the repository root, use `pnpm worker:reference:build` or
`pnpm worker:reference:test`. To launch the reference worker for comparison,
give it an owned disposable profile and test server before running
`pnpm --filter @cantrip/worker-reference reference:start`.

`guest-helpers/` contains the old JavaScript helper source for fixtures that
compare the executor's file and Run wire formats.
