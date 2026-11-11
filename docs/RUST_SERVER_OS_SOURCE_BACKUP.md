# CantripOS source backup restore and rollback

The browser SDK creates two workspaces in an isolated CantripOS guest and
provisions a Linux-owned project source in the first. The full worker captures
that workspace into its encrypted archive. The browser opens the private
capture metadata and verifies that it names the original source binding.
The test retains the exact encrypted archive and verifies its digest after
restore and rollback.

The restore targets the second workspace, which contains distinct original
data. The guest receives and verifies the archive, exchanges the active home,
and remaps the restored files to the destination UID and GID. An independent
Docker read checks the restored Unicode filename, exact binary bytes, checkout
file, file mode and ownership. The worker completes and journals the restore
before the harness drops its successful response. The test kills the production
server, reopens the admission, and recovers the exact protected worker receipt.

The test writes a new file into the restored home before rolling it back.
After the worker journals the completed rollback, the harness drops that
response and kills the worker. The server records an unknown outcome.
Observation through a replacement worker recovers the original protected
receipt. The previous destination home is active again and the displaced home
retains the later write. Guest inode checks show that replay leaves both homes
in place. The source home retains its original inode, file bytes, mode and
ownership. The browser reopens and authenticates all three history entries.

The first production comparison exposed Rust's generic 409 response for a
rollback targeting the wrong workspace. The fix uses the existing placement
error type for the reference server's known backup admission and continuation
conflicts. The comparison now checks the complete HTTP status and error body
for seven cases, covering stale or missing placement, reuse of an admission
ID with changed input, missing or wrong-kind backup references, rollback to
a different workspace, and stale continuation authority.

All six local account-authenticated cells pass across the Rust and Node peers
on PGlite, bundled PostgreSQL and external PostgreSQL. They retain 48 compared
product snapshots, 30 exact guest file observations, 18 protected receipts,
12 dropped worker replies and 42 conflict responses. The full worker, browser
crypto and guest recovery helpers execute normally. Only the selected outgoing
worker replies are intercepted. The older development image failed to launch
the recovery carrier. The recorded Phase 5 ARM64 image runs all seven existing
worker backup integration cases and also passes the retained Run output
truncation test that failed on the older image.

All 86 Rust library tests, strict Clippy, and scoped formatting pass.
The full local `pnpm check` reaches the worker suite and reproduces the two
existing model-capacity test failures and two unhandled rejections. The worker
and protocol source and lockfile match the recorded failing baseline. See the
[baseline report](RUST_SERVER_OS_EXECUTION_CONTRACTS.md).

Build the normal browser and worker dependencies. Supply the exact native
server, worker CLI, database assets and Phase 5 guest image. Select the image
with `CANTRIP_TEST_OS_IMAGE`.

```sh
node --import tsx scripts/server-rust/actual-folder-client.mjs \
  --cantrip-os-source-backup --database pglite --report .qa/os-source-backup.json
```

Repeat with `bundled-postgres` and `postgres`. The
[acceptance record](security/rust-server-os-source-backup-acceptance.json)
identifies the tested artifacts and the retained reports.
