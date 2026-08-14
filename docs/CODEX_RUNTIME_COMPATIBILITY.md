# Codex Runtime Compatibility

Cantrip integrates with Codex through a worker-owned `CodexRuntime` adapter. The
default adapter is `CodexAppServer`; the browser and Cantrip server never talk
to Codex App Server directly.

## Tested range

Cantrip currently pins and builds `codex-cli 0.147.0` from the official
`rust-v0.147.0` source tag. Its resolved commit, imported source manifest, and
manual update workflow live under `cantrip_codex/`. The protocol validators and
fixtures were checked against the TypeScript and JSON Schema bindings generated
by that CLI on August 13, 2026:

```sh
codex app-server generate-ts --experimental --out <temporary-directory>
codex app-server generate-json-schema --experimental --out <temporary-directory>
```

The adapter's compatibility range is `>=0.147.0 <0.148.0`, but packaged
workers contain exactly `0.147.0`; they do not select another compatible patch
from the host. Advancing even within the tested range is a Cantrip source and
worker release. Expanding the range requires regenerating the bindings,
reviewing schema changes, and updating compatibility tests.

Cantrip keeps the imported snapshot pristine and applies a reviewed patch
series from `cantrip_codex/patches/` only to the ignored build copy. The current
patch adds an explicit `dynamicTools` override to `thread/resume`: omission preserves
persisted declarations, while `[]` clears them. Cantrip sends the empty override
and its CLI developer instruction on both thread start and resume, migrating
pre-cutover chats without discarding their conversation history. The build also
downloads the sandboxed Rusty V8 archive and binding from OpenAI's official
versioned Codex dependency release, verifies their published SHA-256 values, and
passes them to Cargo. The ordered patch-set hash is part of the runtime manifest
and invalidates cached binaries.

## Startup negotiation

Packaging builds the pinned source with Cargo's locked dependency graph and
upstream Rust toolchain, then places the native CLI, companion processes,
platform sandbox resources, and their SHA-256 manifest in the Worker. Before
publishing its first heartbeat, the worker:

1. validates the bundled target and every artifact hash before executing it;
2. runs the bundled binary with `--version`, parses its semantic version, and
   requires it to match the package manifest;
3. starts a short-lived App Server over its stable stdio transport;
4. validates the `initialize` response fields used by Cantrip;
5. requests `experimentalFeature/list` and validates every returned feature;
6. probes a fixed set of read and execution method names with deliberately
   invalid parameters, treating JSON-RPC `-32601` as unavailable and other
   responses as evidence that the method exists; and
7. publishes and persists the resulting version, initialize metadata, feature
   stages, enablement, and per-method states in the worker heartbeat.

The probe does not create threads, run commands, mutate configuration, or
require authentication. Cantrip's active App Server still uses a loopback-only
WebSocket because the attachable Codex terminal depends on the remote endpoint;
that transport is not exposed to the browser or network.

The optional method inventory covers the native customization families Cantrip
uses: collaboration modes, goals, hooks, skill discovery/configuration/extra
roots, MCP inventory/OAuth/resource read/reload, plugin list/read/install/remove,
external-agent detection/import history, and effective configuration reads.
The probe deliberately sends invalid parameters, so discovering a mutation
method cannot install a plugin, change a skill, import configuration, or start
OAuth.

## Compatibility states

- `compatible`: the version is in range, initialization validates, every core
  method exists, and every currently tracked optional method is available.
- `partial`: core turns are safe, but an experimental or optional method is
  unavailable. Features using that method must be disabled or return a clear
  capability error.
- `incompatible`: the version is outside the tested range, initialization is
  invalid, or a core thread/turn method is unavailable. The adapter refuses to
  start agent work and reports why.
- `missing`: a development override or unpackaged development worker cannot
  find an executable or obtain its version. Release packaging fails earlier if
  the bundled executable or manifest is absent or inconsistent.

Version strings are a safety boundary, not a capability substitute. Runtime
code checks the negotiated method map and fails explicitly when a known method
is unavailable. Experimental APIs are requested only when the initialization
probe accepts that capability.

Method existence is necessary but not sufficient for a customization control.
Feature-backed controls also require the corresponding advertised feature to be
enabled and not in the `deprecated` or `removed` stage. Read and mutation
methods are tracked independently so a runtime can remain inspectable while a
write control degrades to disabled.

Product readiness may be stricter than method discovery. Codex 0.147 stabilizes
the core plugin list/read/install/uninstall methods, but Cantrip has not yet
implemented and validated plugin product operations against their payloads.
Cantrip retains those methods in diagnostics while disabling plugin product
controls until that separate feature adoption is complete. See
[Codex-native customization](CODEX_NATIVE_CUSTOMIZATION.md).

Permission profiles are additionally gated on experimental API negotiation and
`permissionProfile/list`. When available, Cantrip pages the advertised profiles
for the active checkout and uses the selected profile on thread start/resume.
When unavailable, it keeps the legacy sandbox path rather than sending an
unrecognized profile field.

## Diagnostics and schema drift

The adapter validates JSON-RPC envelope shape before dispatch. It keeps the most
recent 100 inbound messages in memory with their original method names and
payloads. Malformed messages, unmatched responses, unknown notifications, and
unsupported server requests are recorded explicitly; warnings log the method
or response id without dumping payload contents to stderr.

The in-memory buffer is intentionally bounded and is not a durable audit log.
Normalized transcript records store the source method and an opaque diagnostic
id so support tooling can correlate a rendered record while the raw entry is
still present. Raw payloads are not copied into durable transcript state. See
`docs/CODEX_EVENT_NORMALIZATION.md` for the normalized surface, redaction
boundary, and restart behavior.

To widen support for a new Codex release:

1. update `cantrip_codex/upstream.json` to an explicitly selected official ref,
   peeled commit, and version, then run `pnpm codex:sync`;
2. generate both binding formats with `pnpm codex:build`'s CLI;
3. compare initialization, feature, request, response, notification, and item
   unions against the current validators;
4. update the fixed method probe and feature gates when methods change;
5. add fixtures for missing, incompatible, partial, and fully compatible
   behavior;
6. run the real-Codex compatibility smoke test and package every supported
   worker target; and
7. change the tested range only after the full Cantrip check passes.
