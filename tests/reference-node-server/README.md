# Retired Node server compatibility reference

This is the development comparison baseline from
`f9a9eb6f7c136f2f5ddae0eee89343dffe5fe762`. Its source and behavioral assertions
are retained for explicit legacy comparisons and rollback qualification.
Repository-relative imports and migration locations follow their current paths;
this directory does not define the production server.

The package has only `reference:build`, `reference:test`, and
`reference:typecheck` scripts. It has no normal build, start, development or
migration command, and all dependencies are development dependencies. Normal
recursive builds, server packaging, desktop launch and deployment use Rust.
The SQL migration chain remains in `cantrip_server/drizzle` and is embedded in
the native executable. Node remains required by the unchanged worker and by
explicit development compatibility tests.

Use `pnpm server:reference:build` and `pnpm server:reference:test` when working
on those comparisons. New server behavior belongs in `cantrip_server_rs`.
