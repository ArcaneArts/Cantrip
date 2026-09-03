# Cantrip Code fix implementation progress

This ledger records verified delivery of the implementation described in
[`CODE_FIX.md`](./CODE_FIX.md). It is updated from merged repository state at the
start of each cycle; a cycle is not marked complete until its pull request has
merged and the result has been observed on `main`.

## Delivery ledger

### Cycle 1 — bounded sidebar Code prewarming

- Branch: `codex/code-fix-bounded-prewarm`
- Pull request: #1642
- Merge commit: `442f348b31dc55950bd6ff3c819a00c610730817`
- Status: merged
- Behavior: explicit members of the existing two-Explorer sidebar preview pool
  may start a hidden, pathless Code workbench; ordinary inactive tabs remain
  dormant; activation reuses the keyed editor, attachment, and iframe.
- Subsystem: app-side Explorer ownership, workbench retention, Code editor
  startup eligibility, and lifecycle regression tests.
- Tests run:
  - Required workspace package builds passed for `@cantrip/version`,
    `@cantrip/logging`, `@cantrip/protocol`, `@cantrip/crypto`, and
    `@cantrip/glitch`.
  - Focused app ownership, lifecycle, popout, controller, and pool suite passed:
    8 files, 89 tests.
  - App typecheck passed.
  - App production build passed.
  - Repository `pnpm check` reached the pre-existing app-decomposition gate and
    stopped because `chat-turn-runtime.ts` and `task-routes.ts` exceed their
    1,999-line budgets. The same gate failure was reproduced on the clean
    primary checkout; neither file is part of this cycle.
  - Full app suite executed 1,949 tests: 1,945 passed, 3 skipped, and one
    unrelated pre-existing settings search assertion failed in
    `settings-page.test.tsx` (`project membership` returned no result). The same
    failure was observed during the clean-baseline audit and does not touch this
    cycle's files.
  - Prettier and `git diff --check` passed.
- Verified result: component tests prove both explicit pool owners start hidden
  and pathless, an unrelated inactive open tab does not start, promotion reuses
  the keyed editor, and the ready attachment and iframe survive the first two
  file navigations without recreation.
- Remaining work: sidebar tree continuity, early extension bridge connection,
  authorized startup payload, authenticated initial-navigation acknowledgement
  and fallback, end-to-end regression audit, and documentation reconciliation.
- Known risks: bounded background workbenches consume resources before the first
  click. The existing pool size of two is the hard ownership cap.
- Manual verification: first-click and post-pin launch traces remain required
  after all implementation cycles land.

### Cycle 2 — sidebar tree continuity during pinning

- Branch: `codex/code-fix-tree-continuity`
- Pull request: #1643
- Merge commit: pending
- Status: pull request open; squash auto-merge pending
- Behavior: pinning no longer promotes the whole file tree into its loading
  replacement. Existing directory rows stay mounted while the established
  path-level pin indicator reports the operation.
- Subsystem: IDE shell-to-sidebar file-tree state mapping and sidebar file-tree
  continuity tests.
- Tests run:
  - Required workspace package builds passed for `@cantrip/version`,
    `@cantrip/logging`, `@cantrip/protocol`, `@cantrip/crypto`, and
    `@cantrip/glitch`.
  - Focused shell sidebar and project file-tree suite passed: 2 files, 20 tests.
  - App typecheck passed.
  - App production build passed.
  - Prettier and `git diff --check` passed.
- Verified result: shell composition coverage proves pending pin and successor
  creation states keep `fileTreeLoading` false while a valid Explorer exists,
  the exact pin path is forwarded, and genuine initial creation/query loading
  still reports loading. Component coverage proves the current row instance
  survives while path-level progress is active.
- Remaining work: early extension bridge connection, authorized startup
  payload, authenticated initial-navigation acknowledgement and fallback,
  end-to-end regression audit, and documentation reconciliation.
- Known risks: none identified; actual Explorer creation and initial directory
  loading still retain their existing whole-tree loading behavior.
- Manual verification: observe one live pin handoff after all cycles land.

## Required completion matrix

| Requirement                                     | Status      | Evidence                  |
| ----------------------------------------------- | ----------- | ------------------------- |
| Bounded hidden pathless Code prewarm            | Complete    | Cycle 1 / PR #1642        |
| First and post-pin selection reuse              | In progress | Cycle 1 plus final traces |
| Ordinary inactive editors remain dormant        | Complete    | Cycle 1 / PR #1642        |
| Sidebar tree remains mounted during pin         | In progress | Cycle 2                   |
| Bridge connects before presentation setup       | Pending     | Future cycle              |
| Authorized initial-file startup payload         | Pending     | Future cycle              |
| Authenticated acknowledgement and safe fallback | Pending     | Future cycle              |
| Tauri/browser and full regression validation    | Pending     | Final audit               |
