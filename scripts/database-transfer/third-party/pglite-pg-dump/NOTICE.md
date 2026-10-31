# PGlite pg_dump factory

Unmodified generated JavaScript factory from `@electric-sql/pglite-tools@0.4.4`,
original `release/pg_dump.js`, recovered verbatim from that published package's
distribution source map. The package is licensed under Apache-2.0; its license is
included alongside this file. Upstream: https://github.com/electric-sql/pglite/tree/main/packages/pglite-tools

Factory SHA-256: `9a4845ba53f0689b42d76a34742f0cfd0175f0d6bd1a0f209cd545d5b07e040c`.

The matching WASM remains an asset of the pinned npm dependency and is supplied
explicitly to the factory by the bounded offline converter. WASM SHA-256 for this
version: `e6a356dbc3a020e4b1bf60b9eff3241f3a1db62706c7e6f36ba5bf96c6a7a73c`. These hashes record provenance and do not gate runtime startup.

Cantrip's adapter obtains the raw SQL before the upstream wrapper's global
psql-command cleanup, which removed matching lines from multiline row/function
literals in a reproduced transfer. Only generated leading/trailing guard commands
are removed by Cantrip. Native serving/background work never imports this code.
