# cantrip-host

Existing host resource mechanisms extracted from Cantrip's Rust server:

- `files::open_private` performs an exclusive file creation with Unix mode 0600.
  `write_private` writes all bytes and syncs that file. Existing destinations fail
  at the actual open; these functions do not probe existence first.
- `files::private_directory` creates directories with Unix mode 0700 and retains
  the original behavior for existing directories. `secure_directory` preserves
  the stricter variant that also applies mode 0700 to the final directory.
- `publish::directory` publishes a complete directory without replacing a
  destination, using Linux/macOS exclusive rename or Windows write-through move.
  Unix parent directories are synced after publication.
- `process::pipe_closed` owns a supplied blocking reader on its own thread and
  notifies on EOF/read failure. The caller supplies the pipe and thread name.
- Unix `process::signal_owned` signals an unreaped child handle or its caller-created
  group, preserving missing-process handling. It does not read PID files or
  decide which processes an application owns.

The server uses these functions for profile publication, private assets and key
creation, and its existing Unix PostgreSQL owner pipe/signal mechanics. Profile
manifests, path admission, checksums, migration/recovery, database installation,
startup commands, lifetime locks, timeouts, and shutdown escalation remain in the
server. Its Windows `pg_ctl` job ownership remains server-owned because that
implementation combines launcher/recovery and process-tree supervision policy.

The crate contains no database driver, server runtime, deployment configuration,
or worker filesystem/Git/PTY implementation. A future worker supplies its paths,
process creation, ownership rules, and supervision policy. Private Unix modes do
not imply a newly introduced Windows ACL policy; Windows behavior is preserved.

The pipe-reader thread exits when its supplied reader reaches EOF/failure. The
caller owns closing the corresponding writer. An unfinished reader is not a
Tokio blocking task that runtime teardown must join. Signaling requires retaining
the real unreaped child handle and creating the group before group signaling.
