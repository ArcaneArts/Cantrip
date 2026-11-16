# cantrip-config

Reusable configuration mechanisms extracted from the server:

- `Environment` and `Reader`: explicit environment maps, missing/empty string
  handling, JavaScript whitespace, booleans, bounded decimal-prefix parsing,
  comma-separated lists, and enum choices.
- `ConfigError`: existing names, messages, and structured validation issues.
- `env_file`: Node-compatible dotenv parsing, non-overwriting map application,
  and the existing optional file loader.
- `resolve` and `entries`: lexical platform path resolution and JavaScript
  object-entry ordering used by configuration values.

Readers take the environment and defaults supplied by their caller. This library
does not select a server/worker configuration, variable prefix, deployment mode,
database, or secret store. It does not initialize logging or services.

`env_file::load_if_exists` is unsafe because it changes the process environment.
Call it only at synchronous startup before other threads can read that
environment. It preserves operating-system variable lookup behavior, sorted key
application, NUL handling, and existing values. The existing error context,
including its server wording, is retained for compatibility. `parse` and
`apply_to` can be used without changing process state.

`resolve` is lexical: it probes neither existence nor permissions. Windows drive
handling is retained. `entries` preserves numeric property ordering, including
the existing key-ring ordering; it performs no cryptographic operations.

The server keeps `ServerConfig`, variable names, defaults, origin/proxy policy,
deployment requirements, peer settings, database selection, and secret-key
configuration. Its public configuration and environment-file imports continue
to work through re-exports. The moved dotenv test compares against Node's actual
file loader; server configuration tests remain with their server consumer.
