# Computer Use: first-tranche acceptance

This experimental feature observes a macOS worker and draws a logical agent
cursor. It does not inject mouse or keyboard input. Desktop and browser clients
use the same protected server route; a phone running the UI is not a capture
target. See the [runtime reference](../cantrip_cua/README.md) for contracts and
the [progress ledger](planned/CUA.md#first-tranche-implementation-progress) for
exact results, platforms, PRs and remaining verification.

## Start the application

From the repository root, with its supported Node, pnpm and Rust toolchains:

```sh
pnpm install --frozen-lockfile
pnpm devtop
```

Normal development preparation builds and installs the CUA helper at its stable
user-data location. Worker startup does not enumerate or capture the desktop.
For a separate disposable QA profile, use:

```sh
pnpm devtop -- --profile cua-acceptance
```

A new profile has its own projects, preferences and model configuration. Complete
its normal setup and configure a model in the app for the agent checks below.
Enter credentials directly in Cantrip. A blank QA profile is not evidence that
the installed app lost its data.

On macOS 14 or newer, the first authorized native operation attempts
ScreenCaptureKit capture. Respond to any OS permission prompt normally; report
the operation's actual error if it fails. Do not reset privacy permissions or
switch signing identities to make the test pass. Stable development certificate
setup is documented in the [runtime reference](../cantrip_cua/README.md#stable-development-helper).

## Manual preview

1. Open a project or standalone agent chat assigned to the local macOS worker.
   Choose **Computer use · Experimental** above the transcript.
2. In **Manual preview**, choose **Connect to agent worker**. Confirm the worker
   identity. The session identity appears after attaching a target.
3. Choose a monitor or window. Use **Next page** when the desired window is not
   on the current page; the inventory can contain many untitled windows.
4. If approval is required, choose **Review approval in chat**, resolve the
   ordinary chat approval, reopen the preview and explicitly retry the action.
   Inventory, attachment, capture and cursor changes can require distinct
   approvals. Selected YOLO adds no CUA confirmation.
5. Request **Snapshot**. Cover a recognizable ordinary test window with another
   window, select the covered window, and capture again. Expect the selected
   window's pixels, without activation or a monitor substituted for it.
6. Change the cursor style, size, color/opacity, label, visibility and trail.
   Choose **Apply cursor**. Click within the snapshot or use the direction
   buttons to move the logical cursor. Fresh pixels contain exactly one cursor;
   this sends no native click/key and does not move the system pointer.
7. Choose **Save applied appearance**. Stop, reload the app, reconnect and select
   a target. The saved appearance should return in the new session; the old
   coordinates and native target identity should not. **Forget saved appearance**
   removes the saved preference while leaving the current cursor unchanged.
8. Resize or move the selected test window and capture again. Close it and
   request another snapshot: expect an unavailable-target error and cleared
   old pixels. Explicitly select a newly created window to continue.
9. Inspect the chat's **Trajectory**. Preview operations identify **Preview
   operator**, their worker/session, outcome, timing and applicable cursor/image
   metadata. Protected Raw details contain no second screenshot copy.
10. Choose **Stop computer use**. Expect cleared pixels and disabled capture
    controls until explicit reconnect. Also try Stop while an approval is
    outstanding; it must not wait for approval. Closing the panel alone preserves
    another observer or agent execution; Stop ends this chat's CUA lifetimes.

Repeat the preview walkthrough in the browser served by development. At a narrow
viewport, confirm the shared controls remain usable. This verifies responsive
web layout, not a native iOS or Android backend.

## Managed MCP in an actual agent turn

Use the same encrypted chat and ask its agent to use the managed `cantrip_cua`
tools. Cantrip supplies them automatically; no user MCP entry or separate helper
launch is needed. Keep these calls in one actual running turn when checking state
persistence. JavaScript has no `console`, shell, filesystem, network or timers;
the final expression is its returned value.

Call `cantrip_cua/js` with:

```json
{ "script": "let page = await cua.targets(); page" }
```

If `page.nextCursor` exists, inspect the next bounded page with:

```json
{ "script": "page = await cua.targets({after: page.nextCursor}); page" }
```

After choosing a test window from the returned page, replace `CHOSEN_ID` below
with its actual ID. This reads its current returned generation rather than
assuming a generation number:

```json
{
  "script": "const chosen = page.targets.find(t => t.id === 'CHOSEN_ID'); await cua.attach({targetId: chosen.id, targetGeneration: chosen.generation}); await cua.configureCursor({version:1,style:'ring',color:'#FFFFFFFF',size:32,label:'MCP',trail:true,visible:true}); await cua.moveCursor({x:20,y:30}); await cua.snapshot();"
}
```

Expect an actual MCP image block showing the selected window and ring. Choose
coordinates inside the selected window. Larger model images may be resized;
map image coordinates using the reported model dimensions and target-local
logical bounds. Do not add the monitor's desktop origin.

To check state, call `js` with `{"script":"let remembered = 73; remembered"}`,
then `{"script":"remembered"}`. Both should return 73. Call `js_reset` with
`{}`, then `js` with `{"script":"typeof remembered"}`; expect `"undefined"`.
Reset also discards the target attachment. State does not survive the end of
the actual agent turn.

While the agent turn remains active after a snapshot, open **Follow agent**,
connect, select its source and choose **Refresh observation**. Expect the same
model image, one cursor, and real thread/turn/session attribution. A later
evaluation, reset or completed turn retires that source. Refresh the source list
after another capture. Stop must clear the source and cancel pending work.

## Reproducible automated checks

```sh
pnpm cua:build
pnpm cua:build:release
pnpm cua:test
pnpm cua:check
pnpm cua:smoke
pnpm cua:test:worker
```

These run explicit fake capture against the compiled Rust executable, including
real worker, protected server/client and managed MCP boundaries. They do not
prove native desktop capture. For the opt-in native fixture, obtain the installed
helper path with `pnpm cua:profile`, then substitute it here:

```sh
pnpm cua:smoke:native --binary /absolute/stable/cantrip-cua --fixture
CANTRIP_CUA_NATIVE_TEST_BINARY=/absolute/stable/cantrip-cua pnpm --filter @cantrip/server exec vitest run test/computer-use-native-preview.test.ts
```

The fixture opens its own patterned target and covering window, checks decoded
pixels through foreground/occluded/moved/resized/recreated states, rejects the
closed target, and cleans up its windows. No screenshot file is written unless
explicitly requested with `--output`.

## Packaging and limitations

The actual worker and desktop chains are:

```sh
pnpm package:worker --target darwin-arm64
pnpm package:app --target darwin-arm64
```

Release verification additionally needs the normal Developer ID and updater
signing configuration; notarization needs the project's normal Apple credentials.
Use the existing distribution workflow. The helper is signed before the enclosing
app, under `art.cantrip.cua`, and bundled at
`Cantrip.app/Contents/Resources/runtime/worker/bin/cantrip-cua`. The final-layout
verifier launches that exact helper and exercises the packaged Sharp encoder:

```sh
node scripts/verify-packaged-worker-cua.mjs /absolute/packaged/runtime/worker --require-developer-id
```

Successful signing or fake smoke alone does not establish capture permission
continuity across app updates. Record the old/new artifact hashes, designated
requirements, actual native capture outcomes and observed prompts separately.

Native capture requires macOS 14+; the rest of Cantrip's OS minimum is unchanged.
Locked, minimized, hidden, protected and other-Space surfaces retain the actual
OS behavior and are not promised to work. Native Retina hardware and physical
mobile-device results must be reported separately from deterministic scale tests
and responsive browser checks. Cursor labels use a limited embedded font.
Real input, Accessibility, clipboard/files, human-input monitoring, continuous
video, other native OS backends and cross-worker control remain deferred.
