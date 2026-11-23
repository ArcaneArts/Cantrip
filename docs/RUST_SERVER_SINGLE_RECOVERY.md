# Single-server native execution recovery

Local macOS arm64 comparisons exercise an actual server SIGKILL while the
production worker and native model stream remain alive. Both Node and Rust now
retain the original Task, Agent and Goal execution across the interruption.
Node remains the default server; full Rust replacement is incomplete.

## Defects and changes

The initial unchanged-worker comparisons reproduced a failed Chat after a
successful native response on both servers. Transparent HTTP diagnostics then
identified lost native receipt and history-identity publication requests. Those
transport errors could fail protected output while the original inference
continued. After correcting publication, the worker reported completion, but
server startup had already suspended its lane and marked the Chat failed.

The worker retries only idempotent receipt settlement and history open/resolve
metadata, with the same parsed request identity. The retry deadline is 30
seconds; caller cancellation and worker transport retirement cancel the wait.
Temporary network/server failures retry, while authority rejections, invalid
responses and unrelated identities fail. Native admission and dispatch keep
their existing behavior; these retries never submit another model input.
This is a necessary integration repair to the existing Node worker.

Both startup repositories retain an active lane only when its exact current
activation and command head reference the matching unfinished GUI logical root.
They preserve that lane's runtime, pending interactions and branch authority,
mark the Chat offline, and await the worker's authenticated outcome. Other
interrupted executions keep their existing recovery behavior. There is no
schema change, new protocol, speculative startup gate or data reset.

## Executed qualification

Source base: `038d6748d7d297c1d7521afe21e3bfd7b1d99b50`.
The complete matrix also passes after integrating `bfbfa6b90` (PR #2760),
including its GUI-rejection worker changes. The counts below describe one
complete matrix, without adding the two repeated runs together.
Optimized native server SHA-256:
`20bb778bd097862de7be6e51ee9d2c90c57dce27700c14e856b53ce36054b985`.

The final combined comparisons use the existing browser SDK, real production
server processes, the complete worker with this metadata repair, and the bundled
native Codex. Only public model HTTP responses are controlled. They exercise:

- A direct Task during held model streaming, then the same Task retained through
  clean restart and a later fault.
- A committed Task admission whose HTTP 202 delivery is lost; replay uses the
  exact original operation and body before and after completion.
- An Agent turn interrupted during its held model response.
- An active native Goal interrupted before delivery of its completion-tool
  response, retaining Goal identity and nondecreasing usage accounting.

Every fault checks the surviving worker PID and credential, original open model
stream, original operation identity and absence of additional inference. Agent
and Goal tests retain the existing canonical-history, native-tool, usage,
synchronization, clean-restart and Goal-clear assertions. Reconnected Chat state
cannot prematurely become failed or unread-complete. Task and Agent history is
read through production HTTP; a second PGlite opener is never used against a
database owned by the running server.

| Storage             | Node / Rust product steps | Deliberate server kills | Clean worker exits | Clean server exits |
| ------------------- | ------------------------- | ----------------------- | ------------------ | ------------------ |
| External PostgreSQL | 17 / 17                   | 8                       | 10                 | 10                 |
| Bundled PostgreSQL  | 17 / 17                   | 8                       | 10                 | 10                 |
| PGlite              | 17 / 17                   | 8                       | 10                 | 10                 |

All three combined processes exited zero. Each peer performs two Task inference
requests and four Agent/Goal inference requests, without duplicate input.
The Node reference for bundled PostgreSQL connects to the fixture's private
external PostgreSQL; Rust actually manages its private PostgreSQL process.
PGlite uses an owned materialization of the actual embedded native runtime.
The damaged shared temporary runtime was left untouched.

Additional local results:

- Native command and GUI-rejection repository suites: 69 tests pass, including repeated startup
  retention for accepted/dispatched/applied GUI input and old non-GUI behavior.
- Current worker metadata/session/rejection/encryption selection: 89 tests across
  five files pass; the earlier four-file selection also passed 84 tests.
- Optimized Rust build and strict release all-target Clippy pass.
- Initial failures and diagnostic runs remain part of the evidence.

An additional three-test startup selection passes the interrupted-lane metadata
test but fails the pending-transition and Task planning/Goal tests. Exact
unmodified base `038d6748d` reproduces both failures at the same assertions,
before either calls startup reset. These failures remain recorded; the selection
is not green and is not counted in the passing totals above.

The repository suite exposed an older assertion that expected an already-applied
Goal setter to become pending after Clear. Unmodified base `038d6748d` reproduces
that failure. PR #2633 intentionally made that setter consumed to prevent
reapplying the native mutation. The updated assertion checks consumed state and
preservation of the original ciphertext, ID and idempotency key; late-epoch
rejection and no-new-claim assertions remain.

The standard `pnpm check` still fails at the unchanged Node line budgets:
`build-app.ts` 1,532/1,500 and `chat-turn-runtime.ts` 2,336/1,999. Downstream steps
of that command did not execute. Development validation runs locally;
GitHub Actions is reserved for releases and deployments.

Reports use `combined-{postgres,bundled-postgres,pglite}-matrix-v{1,2}.json` under
the owned `.qa/rust-single-server-recovery` evidence directory. Retain the
failure reports, original profiles and exact artifacts in verified cold storage
before removing the owned worktree and disposable runtime installation caches.

## Remaining scope

This qualifies one server process dying while its worker/native execution
survives. It does not establish worker/native-process interruption, database
failure, an unlimited outage, mixed-peer GUI authority transfer, recovery of
lanes already suspended by an older server, or supported-platform qualification.
The existing mixed-peer Task tests remain separate evidence.

Current model-operation, catalog and CantripOS behavioral acceptance, final
packaged/client/platform and Winterhold rehearsal, performance comparison,
default Rust cutover and production Node-server removal remain required.
