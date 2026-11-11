# Provider account status and sign-out

The production Rust executable and compiled Node reference passed the same
browser SDK and full-worker scenarios in account mode on macOS ARM64. The Rust
cases use PGlite, bundled PostgreSQL and external PostgreSQL. The Node reference
uses JavaScript PGlite and isolated PostgreSQL databases.

Each peer creates ChatGPT and Grok providers and two accounts per provider
through the existing encrypted browser SDK. The disposable worker receives a
synthetic API-key file for ChatGPT and a legacy file with an unrecognized shape
for Grok. A status request without a worker reads the stored signed-out state
without sending any worker auth command. Supplying the enrolled worker sends
`provider.auth.legacy.capture`, reports the unsupported legacy file and
preserves it.

The browser SDK then signs out each selected account. The worker completes
legacy capture, `codex.auth.logout` and `provider.auth.account.clear` in that
order. ChatGPT executes native Codex `account/logout` against its isolated
credential home. Grok uses the production worker's local sign-out handler.
Both public routes return HTTP 204, and the browser reads the signed-out state.
The selected file disappears and the neighboring account's file remains
byte-for-byte intact. The synthetic values stay out of worker diagnostics.

The old server removed the direct `codex.auth.status` producer in `0a736e17d`.
Current Rust and Node still expose `GET /api/codex/auth/status`, which resolves
stored account state and pending observations. It can request legacy credential
capture for an available worker or refresh a signed-in account's catalog. The
worker retains the original command decoder and handler.

The [acceptance record](security/rust-server-provider-auth-worker-acceptance.json)
identifies the executable and reports. The existing controlled
`provider-auth-http-compatibility.mjs` and `settings-auth-cases.mjs` comparisons
cover authenticated capture, pending observations, malformed replies and
portable-record logout decisions. This product run uses synthetic local files.
Upstream OAuth, provider revocation and multi-worker interruption remain outside
this result. Full supported-platform shipping acceptance remains open.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --provider-auth --database pglite --report /absolute/path/to/auth.json
```

Repeat for `bundled-postgres` and `postgres` with the same production server,
worker and Codex artifacts. Prepare PostgreSQL using the local
`CANTRIP_TEST_POSTGRES_BIN_DIR` fixture setting.
