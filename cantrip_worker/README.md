# Worker development directory

The Rust worker uses this directory to resolve its development `.env` and
relative profile paths. `pnpm --filter @cantrip/worker dev` and
`pnpm --filter @cantrip/worker start` launch `cantrip_worker_rs`.

The retired TypeScript worker lives in `tests/reference-node-worker` with
its compatibility fixtures.
