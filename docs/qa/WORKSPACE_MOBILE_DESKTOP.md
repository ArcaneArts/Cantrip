# Concurrent mobile and desktop workspace acceptance

Run from the repository root with Node 22+ and pnpm installed:

```sh
pnpm install --frozen-lockfile
pnpm --filter @cantrip/version --filter @cantrip/logging --filter @cantrip/protocol --filter @cantrip/glitch --filter @cantrip/crypto build
pnpm cli:build
pnpm exec playwright-core install chromium
node scripts/qa/workspace-mobile-desktop.mjs
```

The harness compiles the actual app and starts disposable local server/worker
processes. It creates a synthetic local repository and account. It never pushes
the repository or reads production data. Both clients share the account through
the real anonymous recovery-file import; they do **not** share browser storage.
The mobile client is touch-enabled Chromium at 390 × 844, not a physical phone.

## Scenarios and expected results

The harness performs these UI actions automatically:

1. On desktop, create the disposable project and open/pin `qa.txt`.
2. On mobile, import the disposable recovery file and open the same project.
   Its workspace identity must differ from desktop's.
3. Edit `qa.txt` without saving; open `second.txt`. Both tabs must remain
   distinct, and desktop's authoritative layout must remain unchanged.
4. Select the first file, resize through desktop width and back, then reload.
   Workspace/tab identities and the dirty buffer must survive.
5. Open the mobile tab picker. Recent ordering must reflect the selected file.
   Close the inactive second file; the first must remain selected.
6. Open `main.rs`. It must default to Edit mode and become the most recent view.
   Close it through the picker; selection must return to its left neighbor.
7. Open/pin another file on desktop. Mobile's authoritative layout must remain
   unchanged. No mobile action may have changed desktop's layout.

## Artifacts and limits

The printed `fixture.ready` event gives the `.qa/editor-<uuid>` artifact directory.
It contains `workspace-mobile-desktop.log` (`QA_EVT` pass/fail records),
`mobile.png`, `desktop.png`, server/worker logs, and failure screenshots/body text
when relevant. Preserve that directory with the exact command and exit status
when reporting a failure. The fixture shuts down its owned processes in `finally`.
The recovery file is for that disposable account only; do not substitute a real
account recovery file or publish the fixture's credential artifacts.

For a manual physical-device follow-up, repeat the numbered actions with two
independent installations connected to a disposable project. Capture screenshots
of both clients after each selection/close and after mobile reload. Verify there
is no transient disappearance, duplicate tab, or unexpected dock insertion.
Record device/OS versions and observations; this automated run does not establish
physical iOS/Android rendering, overflow with many tabs, native popout handoff,
or every surface adapter's lifecycle behavior.
