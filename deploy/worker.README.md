# Cantrip Worker distribution

Install Node.js 22 or newer, copy `.env.example` to `.env`, and export those
variables with your process supervisor before running `start.sh` (Unix) or
`start.cmd` (Windows). The package includes the pinned Codex CLI built and
verified with this worker release. Use the same worker token configured on the
server. The worker makes the outbound server connection; apps never connect to
workers directly.
