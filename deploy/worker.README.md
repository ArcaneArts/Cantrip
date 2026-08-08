# Cantrip Worker distribution

Install Node.js 22 or newer, install the Codex CLI, copy `.env.example` to
`.env`, and export those variables with your process supervisor before running
`start.sh` (Unix) or `start.cmd` (Windows). Use the same worker token configured
on the server. The worker makes the outbound server connection; apps never
connect to workers directly.
