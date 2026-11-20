# Cantrip PTY support

This crate carries the `codex-utils-pty` source from Codex 0.166.0 and the
Cantrip worker's process and terminal adaptations from #3175, #3215 and
#3280. It supplies native PTYs, pipe transport and owned process management
for the worker and browser. The dependency retains the `codex_utils_pty`
library name for its callers and upstream tests.

The pristine Codex source under `cantrip_codex/upstream` supplies the bundled
Codex application build. Apply updates to this crate separately when changes
in upstream PTY behavior are required by Cantrip's worker or browser.

See [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution.
