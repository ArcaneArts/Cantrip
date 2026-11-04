# Native Linux runtime adapter

This checkpoint connects the pinned native app-server to a captured CantripOS
source through its existing environment provider. The app-server and provider
credentials stay on the owning worker; native shell, filesystem, search, and patch
tools use the guest executor. This adapter is not yet the client target picker or
the Server's chat-placement workflow.

`OsNativeEnvironment` captures the source/instance/workspace identities and
attachment, runtime, and binding generations. Each placement needs its own private
native runtime home. Its `environments.toml` disables the local environment and
starts the authenticated Docker/strict-SSH carrier with the expected guest
capability. Existing homes cannot be repurposed for another placement. A stale
runtime is rejected by actual executor observation, and guest cwd values use Linux
path semantics.

`CodexAppServer` passes this environment explicitly when starting/resuming threads
and starting turns. Permission profiles remain native permission profiles. OS
turns do not use the worker's automatic whole-turn retry loop, and do not obtain
host computer-use authority. Linux-owned Git snapshots use the guest; linked Git
inspection remains on its original worker. A failed final observation is reported
as unknown and does not select a host directory.

Native turn interruption can retain resumable exec sessions. For an OS turn,
Cantrip explicitly terminates the native process IDs whose command items were
observed in that turn. This preserves independent executor sessions and commands
from other turns. The packaged executor's process-tree cleanup handles sudo and
children that start another process group. Transport failure during cancellation
is an error; it is not a confirmed stop.

## Reproduce the component tests

Use a disposable attached instance with `cantrip-os-executor` installed. The test
owner/worker UUIDs are the fixture identities in the test source, so these tests
must not target an instance attached to somebody else. Each run creates a unique
workspace and closes its executor afterward, retaining its files for inspection.

```sh
CANTRIP_OS_TEST_CONTAINER=cantrip-os-sources-test \
CANTRIP_CODEX_TEST_BINARY=/absolute/path/to/pinned/codex \
  pnpm --dir cantrip_worker exec vitest run \
  test/os-native-environment.integration.test.ts \
  test/os-native-turn.integration.test.ts --maxWorkers=1
```

Set `CANTRIP_OS_TEST_TRANSPORT` to a private strict-SSH transport JSON file instead
of the Docker variable for an installed VM. The turn fixture also accepts:

- `CANTRIP_OS_TEST_PERMISSION_PROFILE=:workspace` for native workspace permissions.
- `CANTRIP_OS_TEST_PERMISSION_PROFILE=:read-only` to prove reading succeeds and
  patch/write attempts leave the seeded files unchanged.
- `CANTRIP_OS_TEST_CANCEL=1` to interrupt a sudo Python parent, detached Python
  child, and sleep descendant, verify all three disappear before closing the
  executor, and verify an independent native process remains running.

The model endpoint is deterministic Responses test scaffolding. The actual pinned
runtime performs the model loop, tool selection, shell/read/search, native patch,
file creation, and Python artifact execution. These tests do not claim a live
provider conversation, product-selected chat, attachment transfer, or served
artifact download. Proofs are written to each test's private temporary directory;
retained copies belong under ignored `artifacts/phase3-native-runtime/`.
