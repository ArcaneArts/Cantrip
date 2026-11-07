# Product desktop and native console acceptance

These opt-in tests use the actual Server, Worker, account encryption, resource
grants and WorkerLink client. Run them against a disposable owner profile with
approved Worker component grants and a running CantripOS workspace desktop.
Use its registered Linux-owned source and an existing native agent console.

The account recovery file supplies the real client encryption keys. Keep it
private and outside tracked files. The caller owns startup and final cleanup of
the disposable Server database, Worker profile, recovery file, guest, image and
build caches. The tests close their WorkerLink sessions and grants. The desktop
test also deletes its own project view in `finally`.

Supply these environment variables to the command:

| Variable                                | Value                                |
| --------------------------------------- | ------------------------------------ |
| `CANTRIP_OS_PRODUCT_TEST_ORIGIN`        | Disposable Server HTTP origin        |
| `CANTRIP_OS_PRODUCT_TEST_RECOVERY`      | Private anonymous recovery JSON path |
| `CANTRIP_OS_PRODUCT_TEST_PROJECT`       | Project owning the Linux source      |
| `CANTRIP_OS_PRODUCT_TEST_BINDING`       | Ready source binding UUID            |
| `CANTRIP_OS_PRODUCT_TEST_RUNTIME`       | That binding's current runtime UUID  |
| `CANTRIP_OS_PRODUCT_TEST_TERMINAL`      | Owned native console terminal UUID   |
| `CANTRIP_OS_PRODUCT_TEST_WORKER`        | Owning Worker UUID                   |
| `CANTRIP_OS_PRODUCT_TEST_TERMINAL_TEXT` | Expected retained console text       |
| `CANTRIP_OS_PRODUCT_TEST_EVIDENCE`      | Optional private output directory    |

```sh
pnpm --filter @cantrip/app exec vitest run \
  src/lib/os-native-console.product.integration.test.ts \
  src/lib/os-desktop-view.product.integration.test.ts --maxWorkers=1
```

Without their required inputs the cases are explicitly skipped. Console
acceptance authenticates ordered output frames and checks the expected text.
Desktop acceptance creates an encrypted source-bound view, verifies the captured
source/runtime/desktop identity, and receives an authenticated JPEG plus actual
display dimensions. It sends the same initial viewport message as the viewer,
then checks agent control mode and absence of a human controller. It sends no
pointer, keyboard, clipboard or model command.

The optional evidence directory contains compact JSON receipts and one desktop
JPEG. Treat these as private workspace observations. Save only bounded evidence
and intended distribution artifacts, then remove the caller-owned disposable
resources. Preserve unrelated data and any active build's caches until its
artifacts have been collected.

These are product API/client transport tests. Rendered browser interaction and
real-provider model turns have separate acceptance records. Use Codex's own
browser for browser testing when enabled.
