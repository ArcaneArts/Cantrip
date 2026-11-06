# Cantrip Redis client changes

This is the crates.io `redis` 1.8.1 package, with the three methods below and
trailing whitespace removed from its README, changelog and two changed Rust
files. The original licenses, package metadata and remaining source are retained.
The original `.crate` SHA-256, matching the registry Cargo.lock checksum, is:

`db7f3d75b5a3301746bff39a767bf4c5c42506b08513527308b3875bfb64a031`

- `MultiplexedConnection::is_closed` observes the actual IO driver's command
  channel. It performs no network probe.
- `ConnectionManager::try_get_connection` obtains an established, open command
  connection without awaiting a reconnect. A closed/failed connection starts
  the existing reconnect path.
- `ConnectionManager::wait_for_connection` awaits the existing connection future
  without sending an additional command.

Cantrip uses these to preserve its Node server's Redis behavior: publication and
health operations fail promptly while the command connection is unavailable;
directory operations keep their ordered queue through reconnect. Using the
unmodified manager for both made an actual unavailable readiness response wait
9.46 seconds, compared with less than 5 milliseconds in the Node baseline.

TLS, URL parsing, authentication, database selection, Redis encoding, IO drivers
and reconnect implementation use the upstream code.
