# Cantrip CLI

`cantrip` is the worker-authenticated command-line surface for Cantrip. The
initial crate provides the executable, Linux-style help conventions, and the
cached worker-broker connection contract. Product commands will be added after
their hierarchy and flag design are agreed.

The CLI is made available to Codex and worker-managed terminals by the worker.
It never stores the worker's server credential. Instead, the worker starts a
loopback broker, writes a protected connection document for the worker's user,
and supplies its path through `CANTRIP_CLI_CONNECTION` to child processes.
