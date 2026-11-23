# Retired hosted validation

These recipes are retained as references for local commands and previous
platform coverage. They are outside `.github/workflows` and cannot be dispatched
by GitHub Actions. Product tests and compatibility harnesses remain in their
original source locations.

Run development validation locally, starting with `pnpm check` and the focused
checks relevant to a change. Rust server checks also use
`node scripts/server-rust/cargo.mjs test` and the existing compatibility scripts
under `scripts/server-rust/`. Record the actual machine, storage modes, results
and limitations; a local macOS result does not prove Windows runtime behavior.

GitHub Actions is reserved for releases and deployments. The active native
bundle workflow runs on the `release` branch. The managed web runtime workflow
is explicitly dispatched to prepare or publish a runtime release. Neither
ordinary pushes nor pull requests should run hosted validation.

The retired TestFlight feedback collection recipe is retained with its
encryption requirements. Run feedback collection locally instead of dispatching
it as a hosted utility.
