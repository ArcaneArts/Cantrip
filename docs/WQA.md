# Wide browser QA (WQA)

## Purpose and scope

WQA is an agent-executable, source-grounded test plan for finding observable
defects across Cantrip. Start a development server and worker, connect through
the real browser client, exercise complete user journeys, and create GitHub
tracker issues for problems found. Cover normal behavior, validation,
persistence, concurrency, interruptions and recovery across feature boundaries.

This file is a plan, not evidence that tests passed. Its initial delivery is
documentation only. Execute the campaign separately after this document merges.
Do not fix application code during the campaign; preserve evidence and file
issues so fixes can be reviewed independently.

The primary target is `cantrip_app` backed by `cantrip_server` and
`cantrip_worker`, including embedded Code, the worker's Codex runtime, and
CLI/MCP operations reached from the UI. Native shells, OS integration, mobile
hardware and production topology require supplemental profiles. A responsive
browser viewport does not establish native platform coverage.

Use current source and shipped contracts when labels change. Design documents
may retain historical sequences. Current-state sections and actual UI take
precedence over old proposals. In particular: standalone Chat has no
Plan/Goal/Inspect/console; Tasks use the account-global scheduler; Run normally
targets Primary; Overview is a project page rather than a movable tab.

## Campaign environments

Use a fresh QA checkout at the tested revision. Never attach this repository's
Primary checkout, personal repositories/history, or existing development
storage as destructive QA fixtures.

| Profile | What it adds                                                                                          | Coverage                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| B       | Browser, local anonymous server, real worker, disposable folders/local Git.                           | Required baseline: navigation, settings, files, Git, terminals, validation, persistence and recovery. |
| M       | Working QA model/provider configured through Cantrip; small local model or account designated for QA. | Actual Codex turns, permission requests, queue, Plan/Goal, Tasks and tools.                           |
| A       | Disposable account server, independent browser identities and an account-enrolled worker.             | Registration, sessions, isolation, worker approval and recovery.                                      |
| G       | Dedicated GitHub sandbox repository accessible to the selected worker's `gh` session.                 | Managed imports, PRs/issues/Actions, managed secondary worktrees and conversion.                      |
| W       | Second worker with independent identity/storage and matching ready project source.                    | Placement, replicas, relocation and conflicts.                                                        |
| C       | Real Chromium-backed Browser surface on the worker.                                                   | Streamed browser navigation, input and recovery.                                                      |
| D       | Disposable graphical worker desktop/window with supported native capture/input.                       | Remote Desktop and Computer Use operated from the browser.                                            |
| E       | Disposable macOS/Windows worker OS user or VM with external Codex history created only for QA.        | External chat import/export; never point discovery at personal history.                               |
| T       | Additional language tools or optional Git facilities.                                                 | Java, Dart, Flutter, Rust, signatures, LFS and submodules.                                            |
| N       | Separately launched Tauri/Capacitor client on the named OS/device.                                    | Listeners, shares, pop-outs, installation, updates and hardware.                                      |
| S       | `cantrip_site` process.                                                                               | Public site, separate from the authenticated app.                                                     |

Rows implicitly require B unless labeled N or S. **Needs** lists additional
profiles; `—` means B suffices. An unavailable optional dependency does not
stop unrelated sections. Attempt real actions where exposed and record actual
outcomes. Do not replace execution with a capability flag, installation-path
check, process-name check or other proxy that could falsely prevent a test.

### Use the intended configured installation

When the user authorizes existing providers, models and settings, identify the
working installation before provisioning another runtime. `pnpm dev` uses
`.cantrip/browser-dev/`; desktop development uses `.cantrip/dev/`, and an
installed desktop app has its own application-data directory. Their encrypted
profiles and worker identities are separate. Starting an old browser-dev
database does not connect to the user's working desktop profile.

For an existing desktop installation, use the supported browser connection:

1. Open that client and read its actual Local server origin from the user/server
   menu. Its loopback port can change on startup; do not guess it from the
   browser development defaults.
2. Start only the development browser frontend with
   `pnpm --filter @cantrip/app dev`, without `VITE_CANTRIP_LOCAL_ONLY=true`.
   In its server switcher, add the origin observed in the desktop client and
   use **Test connection**, then **Save and switch**.
3. If the browser requests anonymous recovery, use **Settings → General →
   Anonymous recovery → Save recovery file** in the working desktop client.
   Import that exported file with the browser's **Import recovery file** action.
   Keep this bearer artifact private and out of logs, source control and issue
   attachments. Do not reset keys or replace encrypted data.
4. Observe the existing project inventory, worker-backed file tree and model
   settings in the browser. Then perform a disposable fixture operation to
   establish execution readiness. A successful connection test alone does not
   prove that the profile is unlocked or the worker can execute.
5. Record the actual client/server/worker versions separately. A development
   frontend connected to an installed release is a mixed-version environment;
   confirm an observed failure against the applicable contract before filing
   a defect. Do not stop or restart the user's runtime for recovery tests;
   those tests require an owned disposable stack.

A recovery screen on the first candidate database is not evidence that the
working installation or its providers are unavailable. Try the actual supported
export/import flow from the working client. If it fails, retain that failure
and apply the bounded recovery/skip rules to the affected cases.

### Start a new disposable baseline stack

Use this path when a new isolated installation is intended. It does not import
the user's existing configuration automatically.

1. Create a separate checkout/worktree at the chosen merged revision using the
   repository workflow. Record its absolute path and `git rev-parse HEAD`.
   This documentation PR's temporary worktree is not a permanent QA environment.
2. From that checkout, run:

   ```sh
   pnpm install --frozen-lockfile
   pnpm dev
   ```

   Retain the long-running terminal session/output. `dev:prepare` builds/reuses
   the CLI, CUA helper, pinned Codex/editor and shared packages. The browser
   script uses `.cantrip/browser-dev/` and `.cantrip/browser-dev/worker/`
   beneath this checkout.

3. Open `http://127.0.0.1:5173` through the browser tool. Vite proxies `/api`
   and WebSockets to `http://127.0.0.1:4310`. Complete actual encryption/recovery
   setup, then perform a real folder/terminal operation to establish readiness.
4. Use a new QA browser context. Record engine, viewport, origin and fresh or
   retained storage. Keep the same origin spelling; `localhost` and
   `127.0.0.1` have different browser storage.
5. Preserve preparation/startup errors; file an issue if the supported path is
   broken. First builds can take time. Record the stage and whether progress is
   advancing; elapsed time alone is not evidence of failure.
6. Default orchestration/proxy use fixed ports. If the actual launch reports a
   collision, preserve the error and arrange non-conflicting execution. Never
   kill an unrelated listener or assume it belongs to this run.
7. Do not use `pnpm devtop` for baseline browser QA: its process-owner logic
   can stop another development stack. Native execution belongs to profile N.

For A, start `pnpm dev:server` in a separate owned session. It launches
disposable PostgreSQL and an account server at `http://127.0.0.1:4320`. Add
that origin through the server switcher. The baseline browser starts in Local
on reload because `VITE_CANTRIP_LOCAL_ONLY=true`; explicitly reselect the
account server afterward. To test persisted remote selection, stop only the
owned Vite process and run `pnpm --filter @cantrip/app dev` without that flag,
retaining the server/worker sessions, or launch the services separately.

Register QA accounts through the UI. Enroll an independent worker with the
UI-generated one-time code following [the hosted guide](HOSTED_DEPLOYMENT.md).
Use a distinct data directory; do not repurpose the anonymous worker's
credentials. Apply the same isolation to W. For an account worker, after normal
development preparation, use a private shell with a newly issued code:

```sh
env -u CANTRIP_WORKER_TOKEN -u CANTRIP_WORKER_CREDENTIAL \
  -u CANTRIP_WORKER_DEVELOPMENT_BOOTSTRAP -u CANTRIP_WORKER_ID \
  CANTRIP_SERVER_URL=http://127.0.0.1:4320 \
  CANTRIP_WORKER_DATA_DIR="$WQA_ROOT/account-worker" \
  CANTRIP_WORKER_NAME="WQA Account Worker" \
  CANTRIP_WORKER_ENROLLMENT_CODE="$WQA_ENROLLMENT_CODE" \
  pnpm --filter @cantrip/worker dev
```

Set `WQA_ENROLLMENT_CODE` privately from the UI, never in committed artifacts.
On subsequent launches omit the one-time code and retain the same data path.
For W use another distinct directory/name and a separate enrollment; when it
is on another host, use a prepared worker checkout/package and the actual QA
server origin accessible there. Do not copy worker identity/key storage.

For separate B server/worker
restarts, preserve the exact environment, bootstrap identity and data paths
from the root `dev` script. Record commands actually used. An account server
without an enrolled worker can test sign-in but cannot prove account execution.

### Browser execution rules

- Initialize the available browser/computer-use tool using its current API
  documentation. This plan assumes no private driver API or selector syntax.
- Locate controls from the observed DOM/accessibility tree or screenshot.
  Prefer visible roles/names; re-observe after navigation, dialogs, iframe
  changes and asynchronous completion.
- Mutate through the UI under test. Shell tools may prepare fixtures, manage
  owned services, collect evidence and verify filesystem/process effects.
  Direct API/database/React manipulation must not replace a browser flow and
  then be counted as a pass.
- Operate embedded Code through supported iframe/browser controls. Observe
  canvas terminals, Browser and Remote Desktop visually; an empty DOM snapshot
  does not prove their content rendered.
- Use two real contexts for concurrency. Same-cookie tabs suit one account;
  account isolation requires independent sessions/profiles.
- Wait for observable completion: saved revision, actual output, settled
  spinner, process exit or recovered surface. Record tool limitations
  separately from app failures.
- Computer Use must target a separate harmless worker test window, never the
  browser controlling this campaign or a personal application.

## Disposable fixture kit

Set `QA_RUN` to a unique run identifier and `WQA_ROOT` to a new absolute path
outside the checkout:

```sh
export QA_RUN="$(date -u +%Y%m%dT%H%M%SZ)"
export WQA_ROOT="/tmp/cantrip-wqa-$QA_RUN"
mkdir -p "$WQA_ROOT/evidence"
```

Keep `manifest.md` and `results.csv` under evidence. Windows uses an equivalent
writable absolute path/platform shell; Unix syntax is not a Windows requirement.

The optional fixture generator uses Python 3.9+ and Git, separate from the
app's runtime prerequisites. Run it once from the QA checkout. It only creates
`WQA_ROOT/fixtures`; an existing directory causes actual creation to fail
instead of overwriting another run.

````sh
python3 - <<'PY'
import json, os, random, struct, subprocess, zlib
from pathlib import Path

root = Path(os.environ["WQA_ROOT"]).resolve() / "fixtures"
root.mkdir(parents=True, exist_ok=False)
folder, repo = root / "attached-folder", root / "local-git"
folder.mkdir()
repo.mkdir()

def write(base, name, value):
    p = base / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(value, encoding="utf-8")

for base in (folder, repo):
    write(base, "README.md", "# WQA fixture\n\nDisposable Cantrip QA files.\n")
    write(base, "src/example.ts", "\n".join(
        f"export const value{i} = {i};" for i in range(1, 81)) + "\n")
    write(base, "notes/space ünicode.md",
          "# Unicode ✓\n\n[local](../README.md)\n\n```ts\nconst answer = 42;\n```\n")
    write(base, "data/table.csv",
          'name,notes,value\nAlpha,"comma, inside",1\nBeta,"two\nlines",2\n')
    write(base, "data/settings.json", '{"enabled":true,"nested":{"value":42}}\n')
    write(base, "data/settings.yaml", "enabled: true\nnested:\n  value: 42\n")
    write(base, "data/settings.toml", "enabled = true\n[nested]\nvalue = 42\n")
    write(base, "data/broken.json", '{"unfinished":\n')
    write(base, "data/empty.txt", "")
    write(base, "logs/long.txt",
          "".join(f"WQA line {i:05d}\n" for i in range(5000)))
    (base / "data/binary.bin").write_bytes(bytes(range(256)) * 32)
    write(base, "conflict.txt", "shared=base\n")
    write(base, ".gitignore", ".env.wqa\n*.local-secret\n")
    package = {"name": "cantrip-wqa-fixture", "private": True, "type": "module",
               "scripts": {"start": "node scripts/wqa-server.mjs",
                           "qa:echo": "node -e \"console.log('WQA_SCRIPT_OK')\""}}
    write(base, "package.json", json.dumps(package, indent=2) + "\n")
    for label, width, height in (("small", 32, 24), ("large", 1200, 800)):
        rng = random.Random(42)
        pixels = b"".join(b"\0" + rng.randbytes(width * 3)
                          for _ in range(height))
        def chunk(kind, data):
            return (struct.pack(">I", len(data)) + kind + data
                    + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff))
        png = (b"\x89PNG\r\n\x1a\n"
               + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
               + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))
        (base / "data" / f"{label}.png").write_bytes(png)
    write(base, "scripts/wqa-server.mjs", r'''
import http from "node:http";
const html = `<!doctype html><title>WQA worker page</title>
<h1>WQA worker page</h1><label>Name <input id="name"></label>
<button id="add">Add</button><output id="result">Clicks: 0</output>
<label>Paste <textarea id="paste"></textarea></label>
<a href="/article">Article</a><a href="/fail">Failure</a>
<div style="height:1800px">Scroll fixture</div><p>WQA_BOTTOM</p>
<script>
let n=0;document.querySelector('#add').onclick=()=>{
document.querySelector('#result').textContent='Clicks: '+(++n)+' '+document.querySelector('#name').value;
};
</script>`;
http.createServer((req,res)=>{
 if(req.url==="/fail"){res.writeHead(500);res.end("WQA intentional 500");return;}
 if(req.url==="/redirect"){res.writeHead(302,{Location:"/article"});res.end();return;}
 if(req.url==="/article"){res.setHeader("Content-Type","text/html");res.end(
 "<title>WQA article</title><article><h1>WQA article</h1><p>The fixture marker is WQA_ARTICLE_42.</p></article>");return;}
 if(req.url==="/robots.txt"){res.end("User-agent: *\nAllow: /\n");return;}
 res.setHeader("Content-Type","text/html");res.end(html);
}).listen(4371,"127.0.0.1",()=>console.log("WQA_HTTP_READY 4371"));
'''.lstrip())

write(root, "outside-boundary.txt", "WQA_OUTSIDE_UNCHANGED\n")
def git(*args):
    return subprocess.run(["git", *args], cwd=repo, check=True,
                          text=True, stdout=subprocess.PIPE).stdout.strip()
git("init", "-b", "main")
git("config", "user.name", "Cantrip WQA")
git("config", "user.email", "cantrip-wqa@example.invalid")
git("add", "."); git("commit", "-m", "WQA root fixture"); git("tag", "wqa/base")
git("switch", "-c", "wqa/side")
write(repo, "side.txt", "WQA_SIDE\n")
git("add", "."); git("commit", "-m", "WQA side fixture")
git("switch", "main")
write(repo, "main.txt", "WQA_MAIN\n")
git("add", "."); git("commit", "-m", "WQA main fixture")
git("merge", "--no-ff", "wqa/side", "-m", "WQA merge fixture")
git("switch", "-c", "wqa/conflict", "wqa/base")
write(repo, "conflict.txt", "shared=other\n")
git("add", "."); git("commit", "-m", "WQA other conflict")
git("switch", "main")
write(repo, "conflict.txt", "shared=main\n")
git("add", "."); git("commit", "-m", "WQA main conflict")
remote = root / "remote.git"
subprocess.run(["git", "init", "--bare", "-b", "main", str(remote)], check=True)
git("remote", "add", "origin", str(remote))
git("push", "-u", "origin", "--all"); git("push", "origin", "--tags")
subprocess.run(["git", "clone", str(remote), str(root / "local-git-peer")], check=True)
print(json.dumps({"fixtureRoot": str(root), "gitHead": git("rev-parse", "HEAD")}))
PY
````

| Fixture | Create/select through the UI                                                                            | Use                                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| F1      | New managed folder named `WQA Managed <run>` in a QA workspace.                                         | Empty state and owned-folder deletion.                                                                        |
| F2      | Attach `fixtures/attached-folder` on the selected worker.                                               | Non-Git behavior, user ownership, files and terminals.                                                        |
| F3      | Attach `fixtures/local-git` with its local bare origin.                                                 | Local Git root/merge commits, diffs, conflicts and recovery; no managed secondary worktrees.                  |
| F4      | Dedicated GitHub sandbox imported/created normally, seeded with F3's files.                             | G profile: collaboration and managed project lifecycle. Never use the real app tracker for sample issues/PRs. |
| F5      | `local-git-peer` as a matching source on W, or an F4 replica there.                                     | Placement/relocation. A second directory on one worker does not prove multi-worker behavior.                  |
| F6      | Run `node scripts/wqa-server.mjs` in F2/F3's UI terminal or saved Run.                                  | Worker HTTP at `http://127.0.0.1:4371`, text/click/scroll page, article and intentional 500.                  |
| F7      | Generated text, small/large PNG, binary, malformed structured data, empty/large text and Unicode paths. | Files/attachments; separately create oversized upload data for actual configured limit.                       |
| F8      | Second independently authenticated browser identity.                                                    | Ownership tests with QA resource IDs only.                                                                    |
| F9      | Harmless worker window with editable text and scrollable content.                                       | D capture/input; never the controlling browser or personal applications.                                      |

Record resource IDs, real worker paths, browser tabs, ports, owned session/PIDs
and sandbox GitHub URLs in the private manifest. Never publish credentials,
recovery material or private content in tracker evidence.

## Execution order and recording

1. Baseline smoke: BOOT-01–05, PROJ-01–04, NAV-01/04, EXP-01/05, TERM-01,
   GIT-01, SET-01 and SEC-01.
2. With M, add MOD-01, AGENT-01/05, INT-01 and TASK-01–04.
3. Run every applicable remaining case. Complete normal feature behavior before
   intentionally disrupting its service.
4. Execute A/G/W/C/D extensions; N and S are separate qualification passes.
5. Finish concurrency/recovery, soak, cleanup and the report.

Record per case: ID, commit, profile/fixture, client context, timestamp, actual
steps, expected/actual results, status, evidence paths and issue URL.

- **PASS**: actual flow and stated assertions observed.
- **FAIL**: app contradicted the expectation; link a new or matching issue.
- **BLOCKED**: an attempted flow could not reach the assertion due to an
  external dependency/environment/tool. Record actual error and recovery
  attempts. A product defect causing the block still requires an issue.
- **NOT RUN**: not attempted; never counted as passed.
- **NOT APPLICABLE**: deliberately excluded by the platform/profile; cite why.

A downstream case blocked by a failed prerequisite links that case/issue.
Continue independent work. Capture evidence before safe retry; repeat once from
a fresh view if useful. Do not retry destructive actions with uncertain outcomes
until their actual state is observed.

```csv
case_id,commit,profiles,fixture,client,started_at,status,actual,evidence,issue_url,blocked_by
```

Routine UI completion may use a recorded 30-second observation window.
Model/download/build/index/scheduler work needs a longer case-specific window
tied to actual progress. Record elapsed time and last state on failures; use
owned service logs to distinguish process failure from stalled presentation.

## Source coverage map

Inventory covers first-party UI/components, client libraries, server
routes/runtime/repositories, worker services, shared contracts and current docs.
It does not promise exhaustive testing of unmodified vendored Code/Codex.
Shared controls are tested in their real feature contexts.

| Touchpoints                                                                           | Cases                   |
| ------------------------------------------------------------------------------------- | ----------------------- |
| `cantrip_app/src/main.tsx`, auth, server connections, key custody                     | BOOT, AUTH, SEC         |
| projects/workspaces, replicas, folder/placement contracts                             | PROJ, WORK              |
| application shell, persistent surfaces, pane/tab layout and DnD                       | NAV, UX, LIVE, SOAK     |
| Settings, provider catalog/routing/authentication                                     | MOD, SET                |
| composer/transcript, native settings/queue/history, managed Codex session             | AGENT, CHAT, INT, TRACE |
| Tasks, `cantrip_server/src/db/task-scheduling.ts`, dispatch and worker task execution | TASK                    |
| external-history discovery, import jobs, project export adapters and native history   | DATA                    |
| Policies/skills/MCP, worker tool catalog, CodeGraph                                   | CUSTOM, TOOL            |
| Explorer/Monaco, structured/tabular/image viewers, worker Explorer                    | EXP                     |
| Code iframe/lifecycle, worker Code, encrypted settings synchronization                | CODE                    |
| PTY/canonical terminal state, linked console, CLI broker                              | TERM, TOOL              |
| Run controls/editor, definitions and worker providers/supervisor                      | RUN                     |
| Git/GitHub surfaces, repository graph, worker operations and operation journals       | GIT, GRAPH, GH          |
| project automations, worker scheduler and conditions                                  | AUTO                    |
| worker enrollment/observations/routing, relocation                                    | WORK                    |
| Browser/Remote Desktop/canvas, CUA and interaction library                            | BROW, DESK, CUA         |
| App Live/WorkerLink, tunnels/shares, endpoint crypto                                  | LIVE, TUN, SEC          |
| Usage/logs/telemetry, managed search, desktop/mobile settings                         | SET, TOOL, NATIVE       |
| `cantrip_site`                                                                        | SITE                    |

Start maintenance at [surface registry](../cantrip_app/src/lib/project-surface-registry.ts),
[creation menu](../cantrip_app/src/components/workspace/project-surface-create-menu.tsx),
[global Settings](../cantrip_app/src/components/settings/settings-page.tsx) and
[Project Settings](../cantrip_app/src/components/projects/project-settings-page.tsx).
New surfaces/settings need new or explicitly mapped cases.

## BOOT — startup and installation state

| ID      | Needs | Browser procedure                                                                                | Expected observations                                                                                  |
| ------- | ----- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| BOOT-01 | —     | Open fresh client during startup; complete actual local recovery setup.                          | Loading reaches usable shell; recovery material saves; no permanent blank page/error loop.             |
| BOOT-02 | —     | Reload after setup; open same origin in second tab.                                              | Identity/unlock recover; no fresh-account reset or data loss.                                          |
| BOOT-03 | —     | Create F1, open terminal and print `WQA_BOOT_OK`.                                                | Real worker execution succeeds in the intended project; bootstrap response alone is insufficient.      |
| BOOT-04 | —     | Stop owned server, reload, restart against same data.                                            | Actionable connection state; projects/history recover without duplicate initialization.                |
| BOOT-05 | —     | Restart only owned worker; retry file/terminal action.                                           | Honest offline state; durable metadata remains; restored execution uses same source.                   |
| BOOT-06 | —     | Close/reopen QA browser without deleting storage.                                                | Last destination/settings return according to profile; local-only startup intentionally selects Local. |
| BOOT-07 | —     | Clear client key storage only in a separate disposable context; open existing encrypted QA data. | Recovery explains missing device state; no silent key replacement or empty-success history.            |
| BOOT-08 | —     | Record displayed app/server/worker/runtime versions.                                             | Available versions match running builds; unavailable version data is not reported as update success.   |

## AUTH — servers, accounts and recovery

Model OAuth is separate from these Cantrip account tests; see
[provider authentication](PROVIDER_AUTHENTICATION.md).

| ID      | Needs | Browser procedure                                                                                                 | Expected observations                                                                            |
| ------- | ----- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| AUTH-01 | —     | Add malformed origin, unreachable origin, then A server through switcher.                                         | Field validation and real network errors are distinct; Local remains usable.                     |
| AUTH-02 | A     | Register A; separately submit blank/malformed/already-used identity.                                              | Valid registration works; invalid input does not create duplicate accounts.                      |
| AUTH-03 | A     | Log out; try incorrect then correct credentials.                                                                  | Errors leave usable form; correct login restores A's data without revealing secrets.             |
| AUTH-04 | A     | Create A project/chat; switch to B in independent context.                                                        | B sees only B inventory; A content/drafts never flash into B.                                    |
| AUTH-05 | A     | As B, follow A-only QA resource link copied from UI.                                                              | Access denied without content/name disclosure; valid B navigation still works.                   |
| AUTH-06 | A     | Switch Local → A → Local with distinct projects/drafts.                                                           | Queries, workers, subscriptions and decrypted content remain scoped.                             |
| AUTH-07 | A     | Reload non-local-only client after selecting A.                                                                   | Remote selection persists; login requested only when session requires it.                        |
| AUTH-08 | A     | Log out during stream/approval; use Back.                                                                         | Protected control/content retire; old resources cannot be operated.                              |
| AUTH-09 | —     | Export anonymous recovery; restore through offered flow in a disposable context; try corrupt artifact separately. | Same identity/content restored; bad material rejected without replacing keys.                    |
| AUTH-10 | A     | Exercise offered device/password recovery with QA custody and mismatched material.                                | Supported access recovery works; another identity cannot be unlocked.                            |
| AUTH-11 | A,N   | Open QR, cancel/expire; complete scan with actual QA device.                                                      | Correct lifetime and reuse rejection; browser camera layout alone is not native sign-in success. |
| AUTH-12 | A     | As QA admin edit Signup access entry; compare ordinary B.                                                         | Admin state persists; B cannot view/mutate administrative access.                                |

## PROJ — workspaces, projects and ownership

References: [folders](FOLDERS.md), [placement](PROJECT_REPOSITORY_PLACEMENT.md),
[workspace changes](WORKSPACE_CHANGE.md).

| ID      | Needs | Browser procedure                                                                                                                    | Expected observations                                                                                         |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| PROJ-01 | —     | Create/rename QA workspace; set default/order; reload.                                                                               | Organization persists and project lists respect selected workspace.                                           |
| PROJ-02 | —     | Create F1 with an already-used QA display name.                                                                                      | Separate projects/physical UUID roots; duplicate names allowed.                                               |
| PROJ-03 | —     | Attach F2 by worker path; open General/Explorer/Terminal.                                                                            | User-owned non-Git root; no GitHub or secondary-worktree capability.                                          |
| PROJ-04 | —     | Attach F3; compare History/capabilities with F2.                                                                                     | Local Git works; GitHub-only tools and managed secondary worktrees remain unavailable.                        |
| PROJ-05 | —     | Try missing/file/wrong-worker paths and duplicate source.                                                                            | Actual errors are actionable; no half-ready duplicate or altered existing files.                              |
| PROJ-06 | —     | Search repeated/Unicode names; access a project; reopen picker.                                                                      | Context distinguishes matches; recent-access order updates.                                                   |
| PROJ-07 | —     | Open Overview via actions, inspect stats/surface links, Back to Project.                                                             | Overview is a page; previous selection/layout returns; folder/Git stats differ appropriately.                 |
| PROJ-08 | —     | Rename project; search/navigate all Project Settings categories.                                                                     | Saved identity propagates; no settings from previously selected project.                                      |
| PROJ-09 | —     | Unlink/re-attach F2.                                                                                                                 | Files remain unchanged; attached-file deletion is never offered.                                              |
| PROJ-10 | —     | Cancel F1 removal, then remove keeping files; attach retained directory.                                                             | Cancellation is inert; default unlink preserves usable files.                                                 |
| PROJ-11 | —     | For another empty F1 choose file deletion; cancel second confirmation, then confirm.                                                 | Two-step confirmation; only exact owned fixture is deleted.                                                   |
| PROJ-12 | G     | Import F4 managed, then another sandbox to a missing exact direct path.                                                              | Selected worker/location honored; progress settles without duplicate import.                                  |
| PROJ-13 | G     | Attach matching Primary; try mismatched repo/file/secondary checkout.                                                                | Matching root is untouched; incompatible targets fail without fetch/reset/remote mutation.                    |
| PROJ-14 | G     | Import managed link; remove external link only; repair through UI.                                                                   | Canonical source stays usable; repair uses free matching link location only.                                  |
| PROJ-15 | G,M   | Explicitly convert disposable managed folder to QA GitHub repo.                                                                      | Files/history retained; capabilities change after success; failures recover.                                  |
| PROJ-16 | —     | Run `git init` after attaching a copy of F2; revisit UI.                                                                             | Capabilities do not silently convert; explicit flow remains necessary.                                        |
| PROJ-17 | —     | Inspect permanent membership; cancel then confirm deletion of a disposable workspace containing a disposable linked project.         | No unsupported membership move; confirmed removal unlinks the scoped project while preserving physical files. |
| PROJ-18 | —     | Submit QA removal while navigating elsewhere.                                                                                        | No duplicate removal/stuck dialog or mutation of new selection.                                               |
| PROJ-19 | —     | Create attached workspace rooted at fixture parent; review discovered repositories, search/select/import F3 and inspect diagnostics. | Paths belong to selected worker; local Git classification/import correct; unselected candidates unchanged.    |
| PROJ-20 | G     | Discover accessible/inaccessible GitHub and unsupported checkout candidates in QA workspace.                                         | Bounded discovery/progress and correct classifications; only explicitly selected supported candidates import. |

## NAV — panes, tabs and retained navigation

Reference: [tabs and panes](TABS.md).

| ID     | Needs | Browser procedure                                                                          | Expected observations                                                                   |
| ------ | ----- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| NAV-01 | —     | Add Agent/Tasks/Terminal/Explorer/Code; inspect unavailable GitHub/desktop entries.        | Correct capability treatment; one placement per created surface.                        |
| NAV-02 | —     | Drag mixed kinds to center/right/bottom; reorder; change project.                          | Destination pane controls placement; no duplicate or cross-project layout changes.      |
| NAV-03 | —     | Split center, focus panes, resize dividers, collapse/expand docks, use full-view controls. | Usable focus/geometry; hover handles appear; restore preserves layout.                  |
| NAV-04 | —     | Leave Explorer draft and terminal output; switch surfaces/projects repeatedly.             | Draft/undo/cursor and PTY retained; hidden views do not fit at zero size.               |
| NAV-05 | —     | Rename/color tab; cancel color edit; change Tabs/Icons/Hybrid.                             | Identity/order unchanged; cancel inert; colors affect intended accents.                 |
| NAV-06 | —     | Shrink until Hybrid collapses and overflows; expand and change theme.                      | Labels restore; selected tabs remain legible/reachable.                                 |
| NAV-07 | —     | Close Agent View and reopen inventory item; separately archive resource.                   | Closing view preserves conversation; archive is distinct and restorable.                |
| NAV-08 | —     | Middle-click tab/project row; right-click and Escape menus.                                | Eligible tabs close; projects never delete; focus restores.                             |
| NAV-09 | —     | Shift twice; search actions/projects/files/scripts; execute one of each available kind.    | Context-sensitive routing; Escape works; ordinary Shift use does not reopen repeatedly. |
| NAV-10 | —     | Use New Agent/Terminal shortcuts in eligible/ineligible views and text fields.             | Only contextual actions run; browser-reserved shortcut limitations recorded.            |
| NAV-11 | —     | Navigate Settings/Overview/project, Back/Forward, then switch rapidly.                     | URL/selection reconcile; stale responses cannot reopen wrong project.                   |
| NAV-12 | —     | Concurrently edit layout in two same-account tabs; reload.                                 | Revision handling converges; no duplicates/orphans or silent loss of unrelated tabs.    |
| NAV-13 | —     | Pin/unpin previews, delete active file and open another file during loading.               | Preview ownership transfers cleanly; stale view retires without blank/wrong editor.     |
| NAV-14 | N     | Pop out mixed pane, focus/reorder, close/re-attach.                                        | One placement owner; no duplicated main view. Native execution recorded separately.     |

## MOD — model providers, profiles and routing

Reference: [provider authentication](PROVIDER_AUTHENTICATION.md). Use dedicated
QA routes; never delete or revoke a personal portable account.

| ID     | Needs | Browser procedure                                                                                                                                                              | Expected observations                                                                                                                             |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| MOD-01 | M     | Add/select QA provider and logical model in Models; send a short project message.                                                                                              | Actual turn completes on selected route; composer and recorded attribution agree.                                                                 |
| MOD-02 | —     | Add/edit/remove disposable Ollama/compatible provider; test blank/invalid URL/key fields and cancel edits.                                                                     | Validation is specific; canceled edits do not save; secrets stay masked after save/reload.                                                        |
| MOD-03 | M     | Load worker-local Ollama catalog; stop only its QA endpoint, refresh, restore and retry.                                                                                       | Worker resolves endpoint; unavailable catalog is recoverable and does not delete saved models.                                                    |
| MOD-04 | M     | Configure two ordered QA routes; make first unavailable before output, send a message.                                                                                         | Eligible fallback is recorded; one logical turn/message, no duplicate execution.                                                                  |
| MOD-05 | M     | Interrupt primary route after a fixture file/command action; observe fallback behavior.                                                                                        | No automatic re-execution on another route after side effects; failure and concrete route remain visible.                                         |
| MOD-06 | M     | Change model and each supported reasoning value; try a model without optional reasoning.                                                                                       | Unsupported controls are unavailable/normalized; next turn uses displayed effective setting.                                                      |
| MOD-07 | M     | Set root/subagent defaults and separate standalone Chat defaults; create new chats and reload.                                                                                 | Defaults apply in correct audience; existing explicit selections are not silently overwritten.                                                    |
| MOD-08 | M     | Configure QA ChatGPT/Grok portable account using normal OAuth, cancel one attempt, complete another.                                                                           | Auth progress/cancel/refresh works; tokens never appear in UI errors/log exports.                                                                 |
| MOD-09 | M     | Inspect multiple QA account usage/reset details and route priority; change priority and reload.                                                                                | Aggregate and per-account values remain distinct; zero usage is not shown as missing; ordering persists.                                          |
| MOD-10 | M     | Open provider analytics/context ring while changing selected model/account.                                                                                                    | Metrics and reset times belong to displayed provider/account; stale responses do not overwrite selection.                                         |
| MOD-11 | M     | Remove a QA model/provider referenced by a draft or Task Worker; then retry selection.                                                                                         | References resolve through supported validation; no phantom model or permanently disabled composer.                                               |
| MOD-12 | M     | Enable automatic titles for QA chats/tasks, use a separate labeling model; then manually rename.                                                                               | Short title derives from initial submitted brief; manual title remains; labeling failure does not fail main execution.                            |
| MOD-13 | M     | Toggle random agent naming and independent task/chat title switches.                                                                                                           | Saved choices persist; random naming suppresses chat auto-title without unexpectedly disabling task titles.                                       |
| MOD-14 | —     | In Models switch General/provider tabs using click, Arrow keys/Home/End; search settings for a provider/model, then remove selected QA provider.                               | Correct model grouping/defaults and selected provider; overflow tab stays visible; search lands correctly and removal falls back to General.      |
| MOD-15 | —     | Create one disposable ChatGPT/Grok provider, try adding another of same kind or changing a compatible provider to that existing kind; add sign-in account to original instead. | Duplicate account-provider creation/conversion unavailable with useful reason; existing provider remains editable and supports multiple sign-ins. |

## AGENT — project conversation and Codex execution

Keep prompts bounded and verify actions independently. Example prompts:

- `Reply exactly WQA_HELLO_42. Do not run commands or change files.`
- `Read README.md, then create wqa-agent-result.txt containing WQA_WRITE_42.
Run a command that prints WQA_COMMAND_42. Stay inside this QA project.`
- `Run a command that prints WQA_STARTED, waits 20 seconds, then prints
WQA_FINISHED. Do not modify files.`
- `Inspect src/example.ts without changing files; give a three-step plan.`

The model may refuse, omit a requested tool or produce an unsuitable answer.
That alone does not establish a Cantrip defect. Record what actually happened;
use an observed tool action/approval to assess routing and lifecycle. Do not
claim permission, subagent or queue coverage from a prose promise.

| ID       | Needs | Browser procedure                                                                                                                                | Expected observations                                                                                                      |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| AGENT-01 | M     | Create project Agent; submit greeting prompt once.                                                                                               | One user/assistant turn, streaming then settled state; model/usage attribution available.                                  |
| AGENT-02 | M     | Submit file/command prompt in F2 and F3; verify file via Explorer and command activity.                                                          | Exact selected root is used; no edits in another project or outside-boundary fixture.                                      |
| AGENT-03 | M     | Edit latest user message and retry; fork an eligible earlier turn and continue both chats.                                                       | Supported edit/rollback semantics are explicit; forks have independent future history and correct inherited context.       |
| AGENT-04 | M     | Send long Markdown/code/Unicode; inspect code highlighting, tables, links and color previews.                                                    | Valid rendering/copy without clipped content, script execution or lost characters.                                         |
| AGENT-05 | M     | During wait prompt choose Pause, wait, Resume, then repeat with Stop.                                                                            | Pause/resume/stop target actual turn; controls converge; stop prevents unwanted continuations.                             |
| AGENT-06 | M     | Submit two prompts during a live turn; edit/reorder/remove queued entries; reload.                                                               | Durable queue order/content survives; canceled entry never executes; entries execute once.                                 |
| AGENT-07 | M     | Steer a live turn; compare with explicit queued input.                                                                                           | Steer affects active turn; queue remains separate; no duplicate user messages.                                             |
| AGENT-08 | M     | Switch model/reasoning/permission settings, rapidly switch chat, then submit.                                                                    | Settings apply to intended next turn; stale preparation cannot cross chat/thread or worker generation.                     |
| AGENT-09 | M     | Switch Default → Plan, send planning prompt, revise plan; return to supported implementation flow.                                               | Read-only planning constraints hold; plan revision/approval and implementation settings are correctly restored.            |
| AGENT-10 | M     | Create bounded Goal with explicit small token budget; observe continuation, pause/resume/stop.                                                   | Same conversation continues with goal status/budget visible; stop/pause does not silently restart autonomy.                |
| AGENT-11 | M     | Run compaction from offered control; reload and continue.                                                                                        | Same chat remains usable; compaction is indicated; canonical history has no duplicate/lost final turns.                    |
| AGENT-12 | M     | Switch between structured chat and linked Codex console before/after first message.                                                              | Same native conversation/settings; empty-thread attachment succeeds; switching does not submit a turn.                     |
| AGENT-13 | M     | Ask for two harmless native subagent reads and inspect their lifecycle/transcripts.                                                              | Actual spawned agents, attribution and completion appear once; no child content leaking into unrelated turns.              |
| AGENT-14 | M     | Duplicate/rename/archive a chat, browse archives and restore.                                                                                    | Expected history/context retained; archive/restore is distinct from Close View; running-agent protections work.            |
| AGENT-15 | M     | Close/reopen view and reload during execution; return after completion.                                                                          | Execution survives presentation changes; history catches up exactly once and running status settles.                       |
| AGENT-16 | M     | Stop worker or server during a real turn, restart with same storage, inspect outcome and retry.                                                  | No fictitious success/duplicate turn; recovery exposes actual resumable/failed state.                                      |
| AGENT-17 | M     | Load enough short turns for pagination; scroll older history while new output arrives.                                                           | Older pages join once; scroll anchors remain stable; no Goal overlay in normal history.                                    |
| AGENT-18 | M     | Open changed-file summary for a multiline agent edit and expand its code preview.                                                                | Full supported preview is reachable; file identity/content matches action; expanded content is not clipped.                |
| AGENT-19 | M     | Edit native model/permission/account defaults; open same session in console and structured view, reload and compare effective settings evidence. | One canonical session configuration; stale edits conflict or refresh; controls show actual native settings.                |
| AGENT-20 | M     | At idle explicitly transfer QA session to another provider/account; inspect queued prompt, interruption/retry and next output.                   | History/settings retained; transfer does not run during active turn or deliver queued input to partially prepared runtime. |

## CHAT — standalone conversations

Reference: [standalone Chat](CHAT.md). Standalone scratch execution is not a
project/worktree or a client-local filesystem.

| ID      | Needs | Browser procedure                                                                                                 | Expected observations                                                                                                  |
| ------- | ----- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| CHAT-01 | M     | Switch IDE → Chat, create standalone conversation, send greeting.                                                 | Standalone list contains no project Agents; conversation runs on selected worker.                                      |
| CHAT-02 | M     | Inspect composer/menu/side panels.                                                                                | No Plan/Goal, Inspect/Trajectory, linked console, native subagents or project-only references/customization inventory. |
| CHAT-03 | M     | Ask to create scratch file; open Chat files, preview/edit/download through supported controls.                    | Isolated scratch file is visible; project files are absent; no full Code workspace is manufactured.                    |
| CHAT-04 | M     | Create second Chat and ask to list its own scratch files.                                                         | First Chat's scratch data does not appear in second Chat.                                                              |
| CHAT-05 | M     | Queue/steer/pause/resume/stop, edit-retry and fork with short prompts.                                            | Shared lifecycle works despite simpler UI; unsupported project operations are not exposed.                             |
| CHAT-06 | M     | Change standalone defaults; compare with existing project Agent and a new Chat.                                   | Separate defaults apply only where intended; IDE state remains intact.                                                 |
| CHAT-07 | M     | Stop owning worker; read history, try create/send; restart and retry.                                             | Existing history remains readable; execution is honestly unavailable; no silent move to another worker.                |
| CHAT-08 | M     | Archive/restore QA Chat; inspect retained scratch files; permanently purge a disposable one through confirmation. | Recovery-window behavior is explicit; restore retains files; purge does not affect other Chats/projects.               |
| CHAT-09 | M     | Invoke managed search/read; ask for IDE-only tools/subagents.                                                     | Standalone managed catalog is limited to `tool_help`/`web_search`/`web_read`; IDE authority cannot be acquired.        |

## INT — attachments, approvals and user interactions

References: [agent interactions](AGENT_INTERACTIONS.md) and
[worker-owned attachments](adr/0003-worker-owned-chat-attachments.md).

| ID     | Needs | Browser procedure                                                                                                | Expected observations                                                                                               |
| ------ | ----- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| INT-01 | M     | Select Read only, request fixture write, then use Workspace/approval-required profile and retry appropriately.   | Actual permission behavior matches selection; rejected write leaves file unchanged; approval targets exact request. |
| INT-02 | M     | Exercise command/file approval: deny one, approve one, cancel while pending.                                     | Each settles once; denial/cancel does not execute action; transcript records meaningful outcome.                    |
| INT-03 | M     | Open same pending approval in two tabs; answer one and try old control in other.                                 | Single durable resolution; stale reply rejected/retired without duplicate side effect.                              |
| INT-04 | M     | Reload/navigate away during structured question/MCP elicitation; return and answer.                              | Question/options/content restore; exact pending interaction resolves without becoming an ordinary prompt.           |
| INT-05 | M     | Stop a turn with pending question/approval.                                                                      | Stop does not wait for answer; retired control cannot resume stopped execution.                                     |
| INT-06 | M     | Select YOLO only on isolated fixture; observe warning and cancel, then deliberately enable for a harmless write. | Warning/cancel and actual profile transition work; no extra invented confirmation or wrong-turn permission.         |
| INT-07 | M     | Attach text/image using picker, paste and drop; remove one before send; submit supported image prompt.           | Correct previews/name/type; removed item absent; real model receives eligible attachment once.                      |
| INT-08 | M     | Paste text large enough for attachment conversion; reload draft and submit.                                      | Conversion threshold behaves as configured; text retained without double inclusion/truncation.                      |
| INT-09 | M     | Try empty, unsupported, oversized and interrupted uploads, then valid small attachment.                          | Limits/error states are explicit; canceled uploads retire; later valid upload/send remains usable.                  |
| INT-10 | M     | Open sent attachment from history after reload; stop worker during preview then retry.                           | Protected metadata/content matches original; offline failure does not misidentify attachment or erase history.      |
| INT-11 | M     | Attempt image on model without image support; select capable model and retry.                                    | Capability fallback/error is accurate; no silently discarded image or unsupported successful claim.                 |

## TRACE — transcript, Inspect, Trajectory and State

Reference: [Trajectory](TRAJECTORY.md). Use real actions from AGENT/INT/CUA.

| ID       | Needs | Browser procedure                                                                             | Expected observations                                                                                                                |
| -------- | ----- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| TRACE-01 | M     | Open Inspect during live turn and after completion; switch Trajectory/State.                  | Trajectory defaults first; State remains live inspector; selected target is current/latest turn.                                     |
| TRACE-02 | M     | Start second turn, then open first turn's Worked for → Trajectory action.                     | Default moves to new turn; explicit historical selection shows only that historical turn.                                            |
| TRACE-03 | M     | Zoom/pan/seek timeline; choose event and event-history item.                                  | Shared time axis/playhead and details stay aligned; selected event remains stable during updates.                                    |
| TRACE-04 | M     | Filter agent/category/status/timing/search; clear filters.                                    | Timeline/history agree; no duplicate lifecycle events or dropped unrelated items.                                                    |
| TRACE-05 | M     | Inspect actual subagents, including nested/completed agents.                                  | Root first; descendants ordered consistently; track scrolling preserves time axis.                                                   |
| TRACE-06 | M     | Inspect Summary/Preview/Raw for command, edit, approval and model events.                     | Correct protected payload; raw opens only deliberately; secrets/screenshots are not redundantly exposed.                             |
| TRACE-07 | M     | Scroll while pointer rests over dense trajectory events in Tasks and normal Inspect.          | Wheel reaches intended scroll area; headers/selected details remain reachable.                                                       |
| TRACE-08 | M     | Switch projects/turns rapidly; reload completed historical trajectory.                        | No cross-chat event mixing; bounded turn loading; errors/empty timing states remain explicit.                                        |
| TRACE-09 | M     | Resize Inspect narrow/wide and select long arguments/output.                                  | Content wraps/scrolls; panes and controls do not overlap composer or tab strips.                                                     |
| TRACE-10 | M     | In State open long running/completed command output and scroll with pointer over output body. | Inner output scroll reaches its content; parent Inspect/task container remains usable without trapped wheel or accidental selection. |

## TASK — Direct, Plan + Goal and global scheduling

Reference: [Tasks](TASKS.md). **Task Workers** are model/concurrency profiles;
**Workers** are physical machines. Do not conflate them.

| ID      | Needs | Browser procedure                                                                                         | Expected observations                                                                                       |
| ------- | ----- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| TASK-01 | M     | With no Task Workers configured, add Direct Task.                                                         | Task persists/queues; no model execution starts; UI explains configuration need.                            |
| TASK-02 | M     | Create enabled Direct-only Task Worker at concurrency 1; inspect queued Task.                             | Eligible Task starts automatically; exact configured model/permissions are used.                            |
| TASK-03 | M     | Add two short Direct Tasks in different projects; hold first with wait prompt.                            | Global capacity is 1; second waits; oldest eligible Task starts when slot is released.                      |
| TASK-04 | M     | Reload/navigate during execution, then reopen Tasks in two tabs.                                          | Same durable task/status/history; no duplicate launch or reset to draft.                                    |
| TASK-05 | M     | Change display priority and Auto ordering; queue another Task.                                            | Display priority does not change oldest-eligible-first scheduling; Auto eligibility/order is respected.     |
| TASK-06 | M     | Pin Task Worker; disable it; compare with Auto Task and re-enable.                                        | Explicit selection remains explicit; ineligible Tasks wait instead of silently changing profiles.           |
| TASK-07 | M     | Raise concurrency to 2, run two Tasks, lower to 1.                                                        | Existing Tasks continue; further claims wait until active count falls below limit.                          |
| TASK-08 | M     | Save invalid concurrency 0/65/non-integer and remove referenced profile.                                  | Validation enforces 1–64; referenced profile is disabled/soft-deleted without losing history.               |
| TASK-09 | M     | Enable Plan + Goal; add planning Task with attachments.                                                   | Planning queues and waits for eligible Plan-capable Task Worker; implementation does not start prematurely. |
| TASK-10 | M     | Answer planning question rounds, edit plan in two tabs, continue planning.                                | Questions/answers persist; stale revision cannot overwrite newer plan; continuation requeues one cycle.     |
| TASK-11 | M     | Finalize reviewed plan into Goal implementation.                                                          | Same native thread/context; intended implementation permissions restored; encrypted chat remains usable.    |
| TASK-12 | M     | Pause/resume/stop Task implementation and pending approvals.                                              | Actual execution and capacity settle correctly; no stale automatic continuation.                            |
| TASK-13 | M     | Cause controlled failure through unavailable QA provider/command; view Active/Failed/Completed and retry. | Failed list is separate; actual cause visible; retry produces one new attempt.                              |
| TASK-14 | M     | Open Task chat/activity/Inspect; return to list and reselect.                                             | Back-to-list works; latest activity order/scrolling correct; no previous Task's trajectory.                 |
| TASK-15 | M     | Leave brief partially typed, autosave, submit, then manually rename.                                      | Partial autosave does not trigger model title request; first submission may title; manual title remains.    |
| TASK-16 | M     | Stop server/worker during claim, restart preserving state, inspect queued/running Tasks.                  | Lease/recovery yields a coherent outcome; no duplicate execution or permanently consumed capacity.          |
| TASK-17 | M     | Archive/restore a QA Task/chat and change eligibility while queued.                                       | Durable task lifecycle remains coherent; archived/disabled work does not unexpectedly run.                  |
| TASK-18 | M,W,G | Relocate eligible Git Task between matching ready sources; interrupt before commit in a separate attempt. | Placement changes atomically; context/permissions persist; no execution on partially prepared target.       |

## DATA — external chats and export to Codex

References: [chat import](CODEX_CHAT_IMPORT.md), [chat export](CODEX_CHAT_EXPORT.md).
E requires a genuinely disposable worker OS account/VM. `CODEX_HOME` alone
does not isolate discovery because normal home-directory candidates are also
considered. Create harmless external conversations through the real Codex
runtime using the fixture working directory; include a finished chat, archived
chat, attachment, and unsupported/in-progress example. Preserve their original
IDs/digests privately. Browser baseline checks the native import card's absence;
the browser may exercise export when its selected worker supports that target.

| ID      | Needs   | Browser procedure                                                                                                | Expected observations                                                                                                                      |
| ------- | ------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| DATA-01 | —       | Open Project General in browser and inspect external history/import entry.                                       | Native ChatGPT Codex import card is absent; browser does not access local Codex history directly.                                          |
| DATA-02 | E,N     | In native QA client discover external fixture history; search/filter/archive/page and inspect source worker/cwd. | Metadata-only discovery, correct matching chats; unsupported child/ephemeral threads excluded or explained.                                |
| DATA-03 | E,N,M   | Select chat, destination worktree/model/route/permission/mode and explicit copy consent; import and continue.    | New resumable Cantrip-managed fork; supported history/activity retained; source conversation unchanged.                                    |
| DATA-04 | E,N     | Import missing/unsafe/changed/oversized attachment example and mixed compatible/incompatible chats.              | Warnings/placeholders preserve usable transcript; per-chat result, no unsafe file read or authentication-file copy.                        |
| DATA-05 | E,N,M,W | Choose source worker distinct from ready destination; interrupt transfer/hydration and retry.                    | Durable stage/progress; transcript readable if hydration failed; retry avoids duplicate fork and verifies safe remaining transfer.         |
| DATA-06 | E,N     | Reopen discovery after import; retry same selected source.                                                       | Durable already-imported indication; no duplicate from stale client/repeated click.                                                        |
| DATA-07 | E,M     | In browser open Export project → Export to Codex; preview ready worktree and select finished Agent chats.        | Target preservation/flattening disclosed; Tasks/live/approval-blocked entries disabled; maximum 20 enforced.                               |
| DATA-08 | E,M     | Export eligible fixture chats and read exported history in external QA Codex.                                    | Fresh native threads discoverable with ordered user/assistant content and exact existing cwd; no project-folder copy.                      |
| DATA-09 | E,M     | Interrupt export, retry, include incompatible chat and inspect per-chat results.                                 | Successful prior results retained/idempotent; no duplicate native import on same operation; failures do not hide successes.                |
| DATA-10 | E       | Inspect exported fixture history/staging and native Open affordance for local versus remote worker.              | No credentials/Cantrip runtime authority transferred; temporary plaintext staging removed; native deep link only where actually supported. |

## CUSTOM — Policies, skills, MCP and audiences

References: [Policies](POLICIES.md), [customization](CODEX_NATIVE_CUSTOMIZATION.md),
[MCP](MCP.md), [CodeGraph](CODEGRAPH.md).

| ID        | Needs | Browser procedure                                                                                                                    | Expected observations                                                                                       |
| --------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| CUSTOM-01 | —     | Create/edit/rename/delete QA Policy; cancel unsaved edit; use available template/import/export.                                      | Stable identity/content; validation/cancel work; no unintended assignment.                                  |
| CUSTOM-02 | M     | Assign benign unique-marker Policies globally, by workspace and project; inspect effective inventory and ask Agent to report marker. | Correct effective scope; no duplicate instructions or policy from another workspace.                        |
| CUSTOM-03 | M     | Set audience IDE/Chat/Both for separate Policy/skill/MCP examples.                                                                   | Runtime inventories and behavior match audience; defaults remain IDE.                                       |
| CUSTOM-04 | M     | Add a harmless local skill; enable/disable/select via project skill picker; reload.                                                  | Effective skill and source are correct; selection works in IDE; standalone has no per-chat picker.          |
| CUSTOM-05 | M     | Inspect global versus project skill roots; use same skill name in QA scopes.                                                         | Source/precedence explicit; unrelated worker/global user configuration is not modified.                     |
| CUSTOM-06 | M     | Add QA stdio/HTTP MCP configuration; enter invalid command/URL, start failed server and retry valid one.                             | Field errors differ from actual launch failure; healthy tools remain usable.                                |
| CUSTOM-07 | M     | Exercise offered MCP OAuth cancel/login and resource read with a QA MCP service.                                                     | Pending auth/resolution/resource content correct; expired actions do not silently authorize.                |
| CUSTOM-08 | M     | Inspect managed Cantrip/CodeGraph rows; attempt edit/remove/name collision using QA configuration.                                   | Managed rows are protected; effective injection remains exact-context; no global Codex configuration edits. |
| CUSTOM-09 | M,G   | Sync/rebuild CodeGraph on two project worktrees; edit file, query it from matching Agent.                                            | Current symbols/root match each worktree; graph failures degrade independently of terminals/files.          |
| CUSTOM-10 | M     | Change customization while a turn is active, then start next turn and inspect readiness.                                             | Supported boundary respected; no stale attachment/reset of active conversation.                             |

## TOOL — CLI/MCP, managed search and web research

A test is browser-driven when input is issued through a UI terminal or Agent
composer and output/activity is observed there. Do not count a shell-only unit
test as completion. Use current `tool_help`/CLI help for exact inputs.

| ID      | Needs | Browser procedure                                                                                          | Expected observations                                                                                                            |
| ------- | ----- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| TOOL-01 | —     | In UI terminal run `cantrip -h`, `cantrip -v`, `cantrip status`, `cantrip target list`.                    | Worker-injected CLI works; inferred project/worker/root correct; no credential document disclosed.                               |
| TOOL-02 | —     | Use UI terminal CLI to list/read Explorer and read/send to an explicitly selected QA terminal.             | UI surface updates match actual target; ambiguous/missing targets fail without selecting wrong resource.                         |
| TOOL-03 | G     | Through UI CLI create/switch/release/remove disposable managed worktree.                                   | Same worktree authority/lifecycle as app; Primary/dirty/active safety respected.                                                 |
| TOOL-04 | M     | Ask project Agent to use `tool_help`, context, target, policy and Explorer tools on fixture.               | Correct managed catalog/binding; observed results correspond to selected project/lane.                                           |
| TOOL-05 | M     | Ask `web_read` for F6 article URL where local-network policy permits; also read an allowed public article. | Extracted content/marker match; local-address policy refusal is recorded accurately rather than bypassed.                        |
| TOOL-06 | M     | Ask managed `web_search` for a harmless distinctive query; read one returned result.                       | Search result IDs/citations and reading work; actual engine failures recover without breaking chat.                              |
| TOOL-07 | M     | Use IDE `web_session_open/snapshot/click/type/close` with allowed QA page.                                 | Real rendered session updates and closes; stale references/session IDs fail explicitly.                                          |
| TOOL-08 | M     | Repeat search/read in standalone Chat; request an IDE web-session/project operation.                       | Only standalone tool profile is exposed; tool discovery cannot expand authority.                                                 |
| TOOL-09 | M     | Stop/restart only QA managed search/browser service through offered worker controls; retry request.        | Runtime health/error/retry observable; ordinary Agent/file/terminal behavior remains available.                                  |
| TOOL-10 | M     | Trigger supported client focus/notice/show-interaction tool from QA Agent with two open clients.           | Exact eligible client/scope receives bounded control; showing an interaction never answers it; reconnect does not replay notice. |
| TOOL-11 | —     | In UI terminal compare `cantrip run` definition/status/log output with RUN tests.                          | CLI and UI agree on stable ID/revision and Primary/default target.                                                               |

## EXP — Explorer, previews and editing

| ID     | Needs | Browser procedure                                                                                      | Expected observations                                                                                          |
| ------ | ----- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| EXP-01 | —     | Open F2/F3 Explorer; expand nested nodes, collapse/reopen and refresh after external fixture addition. | Lazy tree/file sizes update; folder has no invented Git metadata; correct root.                                |
| EXP-02 | —     | Open README/Unicode Markdown and use local links/code-copy.                                            | Rendering and link routing correct; Unicode/spaces preserved.                                                  |
| EXP-03 | —     | Open JSON/YAML/TOML and CSV in visual mode; switch text/editor and back.                               | Structured/table content correct, including quoted commas/newlines; view switches do not alter bytes.          |
| EXP-04 | —     | Open malformed JSON, empty file, binary, small/large PNG and long text.                                | Supported preview or explicit bounded/unsupported state; image zoom/pan works; no crash or fake empty success. |
| EXP-05 | —     | Edit text in Monaco, Save, reload and inspect exact file from terminal.                                | Bytes match saved edit; dirty indicator clears only on successful save.                                        |
| EXP-06 | —     | Leave unsaved text/cursor/scroll/undo; switch tabs/projects and return.                                | Editor session survives normal navigation; undo targets correct file.                                          |
| EXP-07 | —     | Edit same file in two clients; save A then stale B; use offered conflict recovery.                     | Optimistic concurrency prevents silent overwrite; both versions remain recoverable.                            |
| EXP-08 | —     | Change/delete/rename open fixture from UI terminal; refresh editor.                                    | Actual conflict/missing-file state; no save to unintended renamed/new path.                                    |
| EXP-09 | —     | Open A then rapidly B before load completes; pin preview and move pane.                                | B stays selected; stale A response cannot replace editor; ownership handoff remains stable.                    |
| EXP-10 | —     | Use F3 Git badges/last-commit metadata and file-history action; compare F2.                            | Metadata is asynchronous and accurate; unsupported Git actions absent for folder.                              |
| EXP-11 | —     | Disconnect worker during list/save, retry after restart.                                               | Draft retained; errors actionable; success is not claimed before write acknowledgment.                         |
| EXP-12 | —     | Try traversal/outside-root text through exposed path/navigation controls.                              | Exact authorized root enforced; outside-boundary file unchanged.                                               |
| EXP-13 | —     | Reopen many files then close active preview and editor; monitor retained hosts.                        | No orphan blank surface, duplicate editor or lost unrelated draft.                                             |
| EXP-14 | N     | Pop out Explorer file, edit/save, reopen from main.                                                    | Single coherent file session/ownership, including native close and reload behavior.                            |

## CODE — project workbench and global customization

References: [Code](CODE.md), [Code settings](CODE_SETTINGS.md). Use the embedded
workbench's native controls, not a guessed DOM inside an unobserved iframe.

| ID      | Needs | Browser procedure                                                                                                                                | Expected observations                                                                                                                   |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| CODE-01 | —     | Open Code on F2/F3; observe loading/readiness, files and startup theme.                                                                          | Correct worker/root; pretrusted workspace; useful editor without hidden onboarding/chat chrome.                                         |
| CODE-02 | —     | Open/edit/save fixture in Code; inspect from Explorer and terminal.                                                                              | Same file bytes; correct error/dirty state and expected editor keyboard behavior.                                                       |
| CODE-03 | —     | Switch projects/tabs 20 times with Code open, return and type.                                                                                   | Workbench session retained; no repeated startup, lost caret/draft or duplicate connection.                                              |
| CODE-04 | —     | Open Code hidden in a dock, reveal after prewarm; resize/split and reload.                                                                       | Hidden readiness/timeout transitions settle; editor fits and accepts input when visible.                                                |
| CODE-05 | —     | Lose worker connection/authorized attachment; use Retry after recovery.                                                                          | Honest recoverable error; renewed attachment does not expose old/wrong workspace.                                                       |
| CODE-06 | —     | Open Settings → Code with no project; alternate Settings/Extensions rapidly.                                                                     | One folderless workbench/attachment; requested subtab wins; unrelated workbench chrome hidden.                                          |
| CODE-07 | —     | Change a harmless editor preference; leave global Settings and return; reload.                                                                   | Same retained iframe where applicable; preference persists via encrypted canonical settings.                                            |
| CODE-08 | W     | Edit different settings keys on two workers, then conflicting same key.                                                                          | Disjoint merge succeeds; divergent same-key state explicitly conflicts rather than last-write-wins.                                     |
| CODE-09 | W     | Resolve each conflict choice in separate attempts; inspect profile recovery copy locally.                                                        | Selected canonical/local decision publishes revision; losing local settings backed up.                                                  |
| CODE-10 | —     | Search Open VSX, open details, install/disable/enable/uninstall a benign QA extension.                                                           | State survives worker restart; native progress/errors retained; no Microsoft Marketplace or automatic update assumption.                |
| CODE-11 | —     | Use Upload VSIX with a benign QA package; try invalid/oversized VSIX.                                                                            | Bounded upload and actionable validation; valid extension appears on selected worker only.                                              |
| CODE-12 | —     | Manually check extension updates and any reload/extension-host prompt.                                                                           | Explicit actions work; update/reload failures leave workbench recoverable.                                                              |
| CODE-13 | —     | Change Code worker in global settings and reopen project Code.                                                                                   | Folderless profile switches explicitly; project Code remains on its actual authorized source.                                           |
| CODE-14 | —     | Retire only QA workbench attachment through its normal lifecycle, then reveal/reload the view and retry after a real root-document HTTP failure. | Actual failed frame navigation is reported promptly with recoverable state; separate reachability guesses do not hide the true failure. |

## TERM — PTYs, consoles and terminal services

Reference: [terminal architecture](TERMINALS.md).

| ID      | Needs | Browser procedure                                                                   | Expected observations                                                                                   |
| ------- | ----- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| TERM-01 | —     | Open UI terminal; print cwd, `WQA_TERM_42` and Unicode/colors.                      | Actual PTY output/input; selected source path and rendering correct.                                    |
| TERM-02 | —     | Type/edit command, paste multiline text, Ctrl+C a wait, resize pane.                | Keyboard/bracketed paste and dimensions work; no duplicate/lost input.                                  |
| TERM-03 | —     | Print 500 numbered lines; switch away/back, reload and reconnect second client.     | Canonical hydration preserves order/content without duplicate tail; input enabled only after hydration. |
| TERM-04 | —     | Run alternate-screen terminal program where installed, resize, hide and reattach.   | Active screen/cursor recover; no raw escape garbage or unsolicited keystrokes.                          |
| TERM-05 | —     | Emit local HTTP link and file path; use clickable overlays; scroll/rescale.         | Links stay aligned; intended browser/file destination opens without intercepting unrelated text.        |
| TERM-06 | —     | Open more than 12 inactive QA terminals, return to an evicted one.                  | Worker snapshot restores display; retention limit does not kill unrelated PTYs.                         |
| TERM-07 | —     | Open same terminal in two clients, type from each sequentially.                     | One PTY with ordered output; no duplicate process; resizing remains usable.                             |
| TERM-08 | —     | Run `qa:echo` from palette/script dialog with idle and busy terminals.              | Command runs in eligible existing or new grouped terminal; busy input not corrupted.                    |
| TERM-09 | —     | Save service command printing heartbeat once/second; enable it and leave view.      | Durable service remains running, reattach shows same process/output.                                    |
| TERM-10 | —     | Exit/crash QA service, observe restart; disable, restart, stop and restart worker.  | Supervisor honors enabled state and explicit stop/disable; no uncontrolled restart loop.                |
| TERM-11 | —     | End ordinary shell process; reopen/close terminal and inspect exit/reconnect state. | Exit shown coherently; renderer not synchronously destroyed before final output.                        |
| TERM-12 | M     | Switch linked console/chat and alter model through supported controls.              | Same native thread/queue/permissions; console exit presentation does not delete conversation.           |
| TERM-13 | —     | Restart worker during rapid numbered output, reconnect.                             | Explicit generation boundary; no stale input delivery or old-screen overwrite.                          |

## RUN — shared definitions and supervised processes

Reference: [Run configurations](RUN_CONFIGURATIONS.md). Save definitions through
the editor; verify their real files under `.cantrip/run-configurations/` using
Explorer/terminal. Ordinary Run starts in Primary even from a secondary view.

| ID     | Needs | Browser procedure                                                                                      | Expected observations                                                                                                               |
| ------ | ----- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| RUN-01 | —     | Open Add Run Configuration; detect F3 Node targets; cancel, reopen and save Shell/Node configuration.  | Detection proposes without writing; save produces stable-ID revisioned definition and visible effective command.                    |
| RUN-02 | —     | Start F6 via Run; observe header/dropdown/Run terminal, restart then stop.                             | Correct generation/status/output; Run terminal is read-only; stop owns process tree.                                                |
| RUN-03 | —     | Click configuration name while stopped then running; select another configuration.                     | Select-and-start/restart semantics; running instances sort first; remembered selection persists.                                    |
| RUN-04 | —     | Edit arguments, cwd, environment source/file/plain variable, before-launch step and platform override. | Preview and actual output reflect effective config; invalid paths/options fail specifically.                                        |
| RUN-05 | —     | Add QA secret reference with dummy canary; run command checking presence without printing it.          | Value available to process, absent from committed definition and exposed logs/errors.                                               |
| RUN-06 | —     | Edit same definition from two clients; save stale copy, then inspect latest.                           | Revision conflict prevents overwrite; stable ID is not replaced by display name.                                                    |
| RUN-07 | G     | Start normal Run while secondary worktree selected; then Run in Worktree explicitly.                   | First uses Primary; second uses exact chosen checkout; separate instance controls.                                                  |
| RUN-08 | G     | Run same definition in Primary and secondary; stop only secondary.                                     | Independent generations/output; Primary remains running.                                                                            |
| RUN-09 | —     | Remove selected stopped definition; try editing/deleting active one via supported lifecycle.           | Selection falls back; active-operation constraints explicit; no orphan process.                                                     |
| RUN-10 | —     | Use nonexistent executable/failing before-launch/nonzero exit, then fix through editor.                | Failed generation/exit code visible; retry recovers without permanent spinner.                                                      |
| RUN-11 | —     | Stop worker during Run; restart same worker/storage and inspect.                                       | Coherent runtime reconciliation; no stale running state or duplicate launch.                                                        |
| RUN-12 | T     | Create detected Java Gradle/Maven, Dart, Flutter and Rust examples; start/stop each.                   | Structured provider options resolve to actual tools; unsupported/missing tool produces real error. Record each provider separately. |
| RUN-13 | T     | For Flutter use device picker, disappearance and alternate target.                                     | Actual selected worker device used; stale device fails explicitly without silent substitution.                                      |
| RUN-14 | —     | Change live Codex environment source and rerun; compare CLI/MCP status/output.                         | Next generation uses current environment reference; definition/state agree across surfaces.                                         |

## GIT — repository history, changes and recovery

Reference: [Git client](GIT_CLIENT.md). Use fresh disposable clones for destructive
subsections. F3 starts clean with root/merge commits, `wqa/base` and
`wqa/conflict`. For conflict tests merge `wqa/conflict` into a disposable
branch created from F3's main. Prepare edits through Explorer/UI terminal; use
Cantrip Git controls for the operation being tested. Never rewrite this app's
Primary branch or push fixture history to the real tracker repository.

| ID     | Needs | Browser procedure                                                                                                               | Expected observations                                                                                               |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GIT-01 | —     | Open History; inspect normal, root and merge commits; select each merge parent.                                                 | Author/message/refs/signature/stats correct; root compares with empty tree; parent selection changes diff.          |
| GIT-02 | —     | Edit lines 5/40/75 of `src/example.ts` through Explorer; stage one hunk, unstage and stage selected lines.                      | Index/worktree patches reflect exact selected lines; unrelated hunks remain unstaged.                               |
| GIT-03 | —     | Open same patch in working changes, commit, comparison, stash and file history; toggle unified/split/whitespace.                | Shared Diff V2 content and line identity agree; no disappearing change on mode switch.                              |
| GIT-04 | —     | Navigate multiple hunks, expand omitted context, copy path/patch and open file.                                                 | Authoritative bounded context grows; navigation/copy/open target selected file/checkout.                            |
| GIT-05 | —     | Add/delete/rename text, change binary/small image and image above 2 MB; inspect both sides.                                     | Rename paths and intentional absent/binary/size-limited states explicit; no corrupted image or invented text diff.  |
| GIT-06 | —     | Commit staged subset with multiline message; cancel one commit dialog; inspect result.                                          | Only staged bytes committed; author/message accurate; cancellation inert; unstaged work retained.                   |
| GIT-07 | —     | Create/switch/rename/delete disposable branch with clean then dirty fixture.                                                    | Branch/worktree identity explicit; unsafe switch/delete explains actual conflict without losing edits.              |
| GIT-08 | —     | Stash with/without untracked files, inspect, apply/pop/drop; test local shelf controls.                                         | Selected contents/lifecycle correct; conflict retains recoverable stash/shelf state.                                |
| GIT-09 | —     | Compare arbitrary refs/working/index states; open file history, blame and revision comparison.                                  | Correct base/head/side and line attribution; renamed/deleted file history usable.                                   |
| GIT-10 | —     | Search commits by message/author/path/date through available controls; open match, clear filters.                               | Bounded results/filter status correct; navigation restores usable full history.                                     |
| GIT-11 | —     | Commit in peer clone, push to bare origin, fetch/pull through UI; commit locally and push.                                      | Ahead/behind and tracking update; operations use selected remote/branch and exact checkout.                         |
| GIT-12 | —     | Add/edit/remove disposable remote, create/delete tag, inspect refs.                                                             | Validation rejects malformed values; intended refs change only; rejected remote operation remains recoverable.      |
| GIT-13 | M     | Generate Git-agent commit/review draft, edit it, cancel, then explicitly submit.                                                | Generation itself changes nothing; only reviewed submission mutates intended Git state.                             |
| GIT-14 | —     | Merge conflict branch; resolve text conflict with provided ours/theirs/manual controls and continue.                            | Exact files/stages shown; continuation requires resolution; final commit/tree matches choice.                       |
| GIT-15 | —     | Repeat conflict and Abort; repeat with rebase/cherry-pick conflict and resume after reload.                                     | Managed operation/progress persists; abort restores expected pre-operation state without dropping unrelated edits.  |
| GIT-16 | —     | Use revert/cherry-pick/reset actions on fresh fixture copies; cancel each destructive review once.                              | Preview accurately describes impact; canceled action inert; confirmed operation targets selected revision.          |
| GIT-17 | —     | Create three disposable commits; use interactive reorder/squash/fixup/edit/drop.                                                | Proposed sequence reviewed; result history/tree correct; conflict/abort recovery remains available.                 |
| GIT-18 | —     | Rewrite branch previously pushed to disposable bare remote; use offered protected/force-with-lease path after peer advances it. | Published-history warning; stale lease rejects force push rather than overwriting unseen remote work.               |
| GIT-19 | G     | Move changes between managed worktrees; select only some changes; try dirty destination.                                        | Exact source/destination and conflicts reviewed; no silent overwrite; source/destination state matches result.      |
| GIT-20 | —     | On a disposable clone start bisect, mark known revisions good/bad, reload and reset.                                            | Durable bisect context/result; normal branch restored; no impact on other project operations.                       |
| GIT-21 | —     | Create a recoverable lost fixture commit; use reflog/recovery browser to restore a branch.                                      | Actual recovered revision/tree displayed; no unrelated branch reset.                                                |
| GIT-22 | —     | Exercise offered fsck/prune/gc recovery/maintenance on clean disposable clone.                                                  | Actual bounded results and errors; no falsely successful check or deletion of reachable fixture work.               |
| GIT-23 | T     | Add local test submodule; inspect, initialize/update and handle missing remote.                                                 | Explicit submodule path/status; errors preserve parent repository; no unintended recursive mutation.                |
| GIT-24 | T     | Track QA binary with LFS, inspect status/locks, test missing LFS or unavailable remote.                                         | Real LFS results and limitation states; missing tool does not prevent ordinary Git.                                 |
| GIT-25 | T     | Inspect unsigned/signed/bad-signature QA commits/tags and offered signing controls.                                             | Signature states distinguish verified/unverified/missing; no claim of verification from presence alone.             |
| GIT-26 | —     | Make external fixture edit while History is open; stop worker during diff expansion then restore.                               | Live WIP/refs update; selected checkout never silently substituted during failure.                                  |
| GIT-27 | G     | Observe all worktree HEAD/WIP markers and branch selection in History.                                                          | Markers match real roots; selecting history actions uses explicit worktree; project-wide view does not merge files. |
| GIT-28 | —     | Race staging/commit/status refresh from two clients on QA repo.                                                                 | Concurrent operation is coherent or explicitly rejected; no mismatched success/diff or lost staged bytes.           |

## GRAPH — repository file graph

This is the interactive repository/file graph, distinct from Git History's
branch graph and from the Agent Trajectory timeline.

| ID       | Needs | Browser procedure                                                                                          | Expected observations                                                                                           |
| -------- | ----- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| GRAPH-01 | —     | Open Graph for F3; select a file and folder node, inspect detail and activate file.                        | Scene matches selected repository; file opens correct path; folder activation is distinct from file activation. |
| GRAPH-02 | —     | Pan/zoom/rotate with displayed pointer/keyboard controls; use Fit and Reset rotation.                      | Predictable geometry/hit-testing; scene remains recoverable and no click through to hidden UI.                  |
| GRAPH-03 | —     | Add/delete/rename fixture file and refresh live graph; select known historical/ghost node where available. | Scene revision and node identity update; missing/historical file routing is explicit.                           |
| GRAPH-04 | —     | Resize/split and test narrow/touch-supported view; activate small/overlapping nodes.                       | Correct canvas scaling and selected path; no accidental activation after drag.                                  |
| GRAPH-05 | —     | Switch repository while scene loads, disconnect worker and retry.                                          | No prior-project scene or stale selection replacing new target; recoverable error.                              |
| GRAPH-06 | —     | Open graph with larger disposable file tree, then navigate away/back repeatedly.                           | Bounded rendering/retention; no growing canvas/listener storm or unusable fit state.                            |

## GH — GitHub collaboration

All sample mutations target F4, a dedicated QA sandbox. Actual Cantrip defects
are filed on the real tracker using the procedure at the end of this document.

| ID    | Needs | Browser procedure                                                                                             | Expected observations                                                                                        |
| ----- | ----- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| GH-01 | G     | Open Issues/PRs/Actions for F4; compare F3 and F2 menus.                                                      | GitHub capabilities reflect verified access; unsupported projects do not expose broken collaboration.        |
| GH-02 | G     | Search/filter/page issue list; create sample issue with multiline Markdown and close/reopen/edit it.          | Correct repository/content/status; pending/error states settle without duplicate creation.                   |
| GH-03 | G     | Open cross-repository inbox where exposed; filter assigned/authored/review-needed items and navigate.         | Repository identity preserved; selection returns to exact resource instead of prior project's item.          |
| GH-04 | G     | Create feature branch/commit; open PR dialog, change base/head, preview diff and submit draft.                | Exact refs/diff and duplicate/no-change validation; only one sandbox PR created.                             |
| GH-05 | G     | Edit PR title/body/base/draft-ready state; cancel a lifecycle dialog and refresh.                             | Changes persist; cancel inert; unsupported transition explains actual reason.                                |
| GH-06 | G     | Review PR files in split/unified; select single and Shift-range lines, navigate comments, prepare suggestion. | Line side/range correct; suggestion uses right-side text; deleted/renamed/binary files explicit.             |
| GH-07 | G     | Submit QA comment/review/reply, resolve supported conversation, inspect after refresh.                        | One GitHub action with correct author/body/state; failed submission retains editable content.                |
| GH-08 | G     | Open checks/status; close/reopen PR; merge eligible sandbox PR using offered method.                          | Actual GitHub eligibility/result; no fabricated merged state or bypass of repository rules.                  |
| GH-09 | G     | Create/open PR worktree, inspect files, close view then remove eligible lane.                                 | Exact PR revision and managed lifecycle; dirty/active deletion protection.                                   |
| GH-10 | G,M   | Launch issue/PR Agent action from sandbox item.                                                               | Prompt/context references exact repo/item; agent targets intended checkout and preserves permission profile. |
| GH-11 | G     | Open sandbox Actions run/job/logs; cancel/rerun a harmless fixture workflow.                                  | Correct run/job/live logs; authorization/error states honest; no action in the Cantrip repository.           |
| GH-12 | G     | Create/edit/delete disposable sandbox release/tag through offered Git controls.                               | Correct target/draft/assets state; cancellation and actual GitHub failures recover.                          |
| GH-13 | G     | Temporarily use a QA worker without GitHub auth or remove sandbox access; retry lists/mutation.               | Actionable authentication/access error; local Git/files keep working.                                        |
| GH-14 | G     | Perform an issue/PR update in second client while first has dialog open.                                      | Refresh or conflict handling preserves actual remote state; no stale success or wrong-item mutation.         |

## AUTO — project automations

Reference: [native customization](CODEX_NATIVE_CUSTOMIZATION.md). Use a harmless
bounded prompt and the shortest interval the UI actually accepts. Record timezone,
next occurrence and real wait. Do not change the system clock to force a run.

| ID      | Needs | Browser procedure                                                                   | Expected observations                                                                                              |
| ------- | ----- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| AUTO-01 | M     | Create automation on QA chat; edit name/prompt/schedule; cancel and reopen.         | Saved fields persist; canceled changes do not save; task and automation concepts remain distinct.                  |
| AUTO-02 | M     | Configure supported interval, weekly and cron schedules; try invalid cron/interval. | Accepted schedule/next occurrence consistent with timezone; validation specific. Record each schedule separately.  |
| AUTO-03 | M     | Let interval occurrence run with `Reply WQA_AUTO_42 only`.                          | One actual occurrence/turn recorded with correct assignment and result.                                            |
| AUTO-04 | M     | Disable before next due time, wait through occurrence, then re-enable.              | Disabled occurrence does not execute; re-enable follows documented scheduling semantics without burst duplication. |
| AUTO-05 | M     | Set script condition to controlled true/false/failure outcomes.                     | False skips, true runs, failure reports condition error; scripts execute on assigned worker.                       |
| AUTO-06 | G,M   | Set open-issues condition around known sandbox issue count; change count.           | Condition uses exact sandbox and threshold; no production issue dependency.                                        |
| AUTO-07 | M     | Restart worker/server across due time; inspect occurrence/job history.              | Durable/idempotent recovery; no double turn or permanently running occurrence.                                     |
| AUTO-08 | M     | Keep chat busy/paused during occurrence; inspect queued execution then resume.      | Queue/autonomy semantics respected; no bypass of pause or wrong-chat prompt.                                       |
| AUTO-09 | M     | Delete QA automation while pending/idle, reload and wait past next due time.        | Explicit lifecycle result; no subsequent execution after confirmed deletion.                                       |

## WORK — worker inventory, replicas and worktrees

References: [multi-worker architecture](MULTI_WORKER_ARCHITECTURE.md),
[worktrees](WORKTREES.md), [placement](PROJECT_REPOSITORY_PLACEMENT.md).

| ID      | Needs | Browser procedure                                                                                                  | Expected observations                                                                                                  |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| WORK-01 | —     | Open Workers; inspect real platform/runtime/health/network graph and project-source associations.                  | Correct identities and live status; no stale local-worker assumption.                                                  |
| WORK-02 | A,W   | Generate one-time enrollment code, enroll QA worker, try code reuse/expiry.                                        | New worker linked once to intended account; old code rejected; credentials not shown in logs.                          |
| WORK-03 | A,W   | Approve worker encryption principal when prompted, then open protected feature; reject separate pending QA worker. | Exact approved worker can decrypt/execute; rejected worker cannot silently gain access.                                |
| WORK-04 | W     | Choose preferred source/worker, create Agent/Terminal/Explorer/Code via explicit menu targets.                     | Resource placement honors exact worker/replica/worktree; header/output/root agree.                                     |
| WORK-05 | W     | Stop preferred worker; inspect existing views and create new surface using Automatic.                              | Existing pinned resource stays unavailable on original target; only supported new placement policy may select another. |
| WORK-06 | G,W   | Provision F4 replica, show progress, select exact revision, synchronize clean source.                              | Revision/readiness correct; worker-owned files and opaque routing remain distinct.                                     |
| WORK-07 | G,W   | Try sync/remove dirty, unpublished or active replica; cancel then handle safely.                                   | Actual safety failure preserves work; no silent reset/delete.                                                          |
| WORK-08 | W     | Attach matching F3 source on W; try wrong revision/repository.                                                     | Only compatible user-owned source accepted; no automatic clone/managed-worktree capability for local Git.              |
| WORK-09 | M,W   | Relocate eligible Agent to ready matching source, inspect transcript then execute marker command.                  | One canonical transcript, correct context/attachments/model/permissions and new worker/root.                           |
| WORK-10 | M,W   | Interrupt relocation during prepare/transfer, restart, inspect and retry.                                          | Atomic placement/recovery; no split identity or execution before committed target.                                     |
| WORK-11 | G     | Create secondary worktree, pin/unpin Agent, lock/unlock, reconcile/prune and remove eligible lane.                 | Primary protected; branch remains after removal; dirty/locked/active/external lanes require proper handling.           |
| WORK-12 | G,M   | Request Agent-managed worktree acquisition and continue next turn after handoff.                                   | Same conversation follows intended lane; past messages retain lane attribution.                                        |
| WORK-13 | W     | Revoke/replace disposable worker; reconnect existing live view.                                                    | Old generation/grants retire; replacement requires actual enrollment/approval, not hostname matching.                  |
| WORK-14 | N     | Exercise Add this machine and local worker recovery/start/stop in native client.                                   | Native ownership/identity correct; browser does not expose a fake local process-manager action.                        |

## BROW — worker-streamed Browser surface

C uses F6. The outer test browser and the worker-streamed Browser are different
clients. The page's `127.0.0.1` belongs to the worker; W on a different host
can establish that distinction experimentally.

| ID      | Needs | Browser procedure                                                                          | Expected observations                                                                           |
| ------- | ----- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| BROW-01 | C     | Add Browser for F2/F3; navigate to F6 URL.                                                 | Actual worker page pixels/title, not client direct navigation or exposed CDP URL.               |
| BROW-02 | C     | Type name, click Add repeatedly, select/paste text, scroll to `WQA_BOTTOM`.                | Input coordinates/keys/scroll correct; click counter increments exactly once per click.         |
| BROW-03 | C     | Navigate Article → Back/Forward/Reload, edit address and use redirect/failure endpoints.   | URL/history and intentional 500 represented correctly; page error does not destroy surface.     |
| BROW-04 | C     | Resize dock/split/viewport; interact near edges at changed scale.                          | Pixel/input coordinate transforms agree; no stale frames/input offset.                          |
| BROW-05 | C     | Use explicit toolbar copy/paste; change device clipboard without pressing action.          | Authorized action works; no continuous clipboard synchronization.                               |
| BROW-06 | C     | Persist harmless page/profile state, close/reopen, then crash/restart only QA Chromium.    | Profile/last URL recover where supported; no endless black canvas.                              |
| BROW-07 | C     | Open same surface in two clients; attach/detach one and continue other.                    | Attachments are independent; closing one does not kill other's active session.                  |
| BROW-08 | C     | Stop F6 server, reload page, restore F6 and retry.                                         | Honest page/service failure; Browser itself remains recoverable.                                |
| BROW-09 | C     | Stop worker or force carrier reconnect during input; retry after recovery.                 | Stale input is not replayed into replacement session; fresh grant/pixels restore.               |
| BROW-10 | C     | Discover worker-local services and use supported open/create Browser actions.              | Correct project/worker routing; useful existing Browser reused or new one focused as specified. |
| BROW-11 | C,W   | Open service available only on remote worker host.                                         | Content comes from selected worker; no client-loopback substitution.                            |
| BROW-12 | C     | Exceed documented QA session/attachment limit using disposable surfaces, then release one. | Actual bounded error; other sessions remain usable; released capacity recovers.                 |
| BROW-13 | C     | Attempt unsupported/invalid URL; return to valid F6.                                       | Validation/errors specific; valid navigation remains usable.                                    |

## DESK — Remote Desktop from browser

Reference: [acceptance](REMOTE_DESKTOP_ACCEPTANCE.md). Positive assertions need D;
a denied operation's honest UI is covered separately.

| ID      | Needs | Browser procedure                                                                | Expected observations                                                                              |
| ------- | ----- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| DESK-01 | D     | Add Remote Desktop, select intended worker if offered, observe F9.               | One-click creation reaches actual worker display; no hostname/password/CDP dialog or fake success. |
| DESK-02 | D     | Click/type/scroll only in F9 through streamed canvas.                            | Exact input target/coordinates; no duplicated key/click or unrelated clipboard action.             |
| DESK-03 | D     | Switch FPS/quality presets, resize and observe motion.                           | Settings persist; actual stream responds within supported range; frames do not queue indefinitely. |
| DESK-04 | D     | Open second client, detach first, reconnect after worker restart.                | Independent attachment lifecycle; stale frame cleared; no stale generation input.                  |
| DESK-05 | D     | Test actual OS-denied capture or unavailable display in separate QA environment. | Clear native diagnostic; failed initial creation does not leave broken phantom tab.                |
| DESK-06 | D     | Navigate away during stream, return and close surface.                           | Retention/cleanup matches lifecycle; no invisible perpetual capture after final teardown.          |
| DESK-07 | D,W   | Open desktop fleet view and explicitly choose remote worker.                     | Correct worker/display identity; local client never becomes accidental capture target.             |

## CUA — Computer Use, logical cursor and input

Use [clicking](COMPUTER_USE_CLICKING.md), [interaction foundation](INTERACTION_FOUNDATION.md),
[effects](COMPUTER_USE_EFFECTS.md) and [helper runtime](../cantrip_cua/README.md).
The older first-tranche acceptance document describes observation-only history;
it is not evidence that current input must be absent.

Do not infer permission from OS settings. Attempt the actual selected operation
and record its response. Do not reset privacy permissions, swap signing identity,
or replay a rejected native action automatically.

| ID     | Needs | Browser procedure                                                                                                     | Expected observations                                                                                                                    |
| ------ | ----- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| CUA-01 | D     | Open experimental preview in eligible project Agent; connect to its worker, inventory/select F9 and request Snapshot. | Exact worker/session/target pixels; no automatic capture just from startup.                                                              |
| CUA-02 | D     | Capture a covered window, then move/resize/close it and capture again.                                                | Window capture does not substitute monitor or activate unrelated target; closed/stale target clears old pixels and requires reselection. |
| CUA-03 | D     | Apply style/size/color/opacity/label/trail; move logical cursor with preview controls.                                | One logical cursor at correct scale; moving preview cursor alone does not inject native click.                                           |
| CUA-04 | D     | Save applied appearance, stop/reload/reconnect, then Forget.                                                          | Appearance persists; old target/coordinates do not; Forget does not unexpectedly mutate current cursor.                                  |
| CUA-05 | D,M   | Trigger capture/input requiring approval, deny/approve actual request, stop while another approval pending.           | Exact durable interaction; stopped session cannot execute late approved action.                                                          |
| CUA-06 | D,M   | Ask Agent to observe F9 and perform bounded click/type/scroll using current tool guidance.                            | Actual requested input and observed receipt, not prose success; target/control identity correct.                                         |
| CUA-07 | D,M   | Exercise supported drag/chord/key-up/down and timed sequence in F9; cancel mid-sequence.                              | Ordered input, cleanup releases held buttons/keys; canceled future steps do not replay.                                                  |
| CUA-08 | D,M   | Attempt stale/offscreen/unsupported input; use explicit documented recovery.                                          | Specific actual error; no fallback to another window/monitor or arbitrary system click.                                                  |
| CUA-09 | D,M   | Inspect preview/Agent actions in Trajectory, including failed/canceled operations.                                    | Operator/session/outcome/timing distinguish preview from agent; no duplicate screenshot raw payload.                                     |
| CUA-10 | D     | Switch observers/chat/worker, close panel versus Stop, reconnect.                                                     | Panel close and session Stop have distinct lifetimes; no cross-chat target/pixels or stale generation controls.                          |
| CUA-11 | D     | Apply supported window effects/filter and appearance preferences to F9; remove them.                                  | Correct target-only result and cleanup; unsupported platforms fail honestly.                                                             |

## TUN — tunnels, shares and browser capability boundaries

References: [tunnels](TUNNELS.md), [network shares](PROJECT_NETWORK_SHARES.md).

| ID     | Needs | Browser procedure                                                                                            | Expected observations                                                                                           |
| ------ | ----- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| TUN-01 | —     | Create/edit/delete saved QA tunnel definition in Global and Project Settings; validate worker/port/protocol. | Explicit worker placement; project association filters correctly; invalid values/cancel handled.                |
| TUN-02 | —     | Inspect native-only Start/Open/reveal operations in browser.                                                 | Browser can manage definitions but cannot claim to bind a local native listener or mount Finder/Explorer share. |
| TUN-03 | C     | Inspect feature-managed Code/Browser tunnel and try generic mutation.                                        | Managed definition is controlled by owning feature; eligible Browser copy creates separate user tunnel.         |
| TUN-04 | N     | Start saved tunnel to F6 with automatic port then colliding fixed port; open endpoint and stop.              | Real native loopback listener; collision is reported, no silent port change; stop retains saved definition.     |
| TUN-05 | N,W   | Interrupt carrier/worker, recover same native endpoint while streaming F6.                                   | Stable listener/URL; new exact grant; no fallback public server share.                                          |
| TUN-06 | N     | Reveal QA project in Finder/Explorer, edit one fixture file through mounted share; use Shift local shortcut. | Authorized share writes correct root; Shift only opens verified local physical source, remote Shift is no-op.   |
| TUN-07 | N     | Revoke share/session and try old mount; then explicitly recreate.                                            | Old authority unusable; new mount only through approved lifecycle; user-owned files preserved.                  |
| TUN-08 | N,M   | Reveal standalone Chat scratch folder and compare two Chats.                                                 | Scratch share remains isolated; no project or other Chat files become visible.                                  |

## LIVE — synchronization, transport and recovery

Reference: [live transport](LIVE_TRANSPORT.md). Observe actual route diagnostics;
setting an environment flag alone does not establish exercised transport.

| ID      | Needs | Browser procedure                                                                                                         | Expected observations                                                                                                          |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| LIVE-01 | —     | Open two same-account clients; create/rename/layout-edit in one.                                                          | Other sees committed state without manual reload; unauthorized scopes never subscribe.                                         |
| LIVE-02 | —     | Disconnect/reconnect one client while changes commit elsewhere.                                                           | Same-epoch replay or explicit snapshot resync converges; no duplicate messages/resources.                                      |
| LIVE-03 | —     | Restart server across active clients, then edit resource.                                                                 | New epoch triggers authoritative recovery; stale cursor cannot suppress updates.                                               |
| LIVE-04 | —     | Pause network through supported browser controls; edit saved draft, restore network.                                      | Honest disconnected state; bounded fallback; draft retained and mutation not falsely acknowledged.                             |
| LIVE-05 | C     | Restart QA stack with `CANTRIP_WORKER_LINK_RELAY_ONLY=true`; exercise terminal, Code and Browser.                         | Diagnostics show actual RELAY; features function; no private payload printed in relay logs.                                    |
| LIVE-06 | C,W   | Restore normal policy; observe eligible actual LAN/WAN route and reconnect a reliable stream.                             | Authenticated route works or relay falls back; reliable stream does not migrate mid-byte sequence.                             |
| LIVE-07 | N     | Test LOCAL on colocated native client, then network change/resume.                                                        | Healthy LOCAL/RELAY preserved as specified; browser-only run does not claim LOCAL qualification.                               |
| LIVE-08 | —     | Switch server/account with terminal/Code attachments open.                                                                | Old streams/grants/subscriptions retire; new account cannot inherit old data/control.                                          |
| LIVE-09 | C     | Congest only QA surface with rapid output/frames, then interact on another surface.                                       | Backpressure/drop/reconnect is bounded; stale frames do not create runaway input lag or block unrelated control.               |
| LIVE-10 | W     | Restart/revoke exact worker generation during live terminal/Code/observation.                                             | Old grant rejected; fresh authorized snapshot restores; worker identity never inferred from address alone.                     |
| LIVE-11 | A,W   | With an explicitly provisioned multi-server Redis topology, disconnect one relay instance and reconnect client elsewhere. | Owner-local replay/resync and routing recover across instances. Without that topology mark BLOCKED/NOT RUN, not baseline pass. |

## SEC — encryption, ownership and private-content handling

Use a unique **non-secret** canary such as `WQA_PRIVATE_<run>` in a prompt,
attachment, filename and dummy Run secret. Protected plaintext is expected on
authorized endpoints; the negative assertions concern server-visible storage,
persistent logs, unrelated identities and unauthorized roots. Source review or
an audit script alone cannot establish browser/runtime encryption coverage.

| ID     | Needs | Browser procedure                                                                                                | Expected observations                                                                                                                                |
| ------ | ----- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-01 | —     | Perform ordinary encrypted file/terminal/history operations after setup and reload.                              | Usable content; no repeated grant storm or silent key rotation/data loss.                                                                            |
| SEC-02 | M     | Send canary prompt/attachment; inspect request payloads via supported diagnostics and server-visible QA exports. | Private fields are ciphertext/envelopes; IDs/status/size metadata can be visible. If payload inspection is unavailable, mark that assertion BLOCKED. |
| SEC-03 | —     | Search persistent client/server/worker log exports for canary, dummy secret, recovery/key material.              | No protected plaintext/credentials in exported records; operational event codes/IDs remain useful.                                                   |
| SEC-04 | A     | Attempt A resources from B using only QA IDs/deep links and exposed UI controls.                                 | Access denied; no names, previews, files, history or worker control disclosed.                                                                       |
| SEC-05 | W     | Reject/revoke QA worker principal, then attempt encrypted surface on that worker.                                | Protected action denied; another approved worker cannot be selected silently to hide failure.                                                        |
| SEC-06 | —     | Paste harmless HTML/script-like Markdown into chat/file content; render and follow link controls.                | Treated as content; no script execution or unintended external navigation.                                                                           |
| SEC-07 | —     | Try path traversal/symlink escape through supported file/Run/attachment controls on fixture only.                | Actual root enforcement; outside-boundary marker unchanged. Do not probe personal paths.                                                             |
| SEC-08 | A     | Log out and inspect prior-tab rendered content/Back history, clipboard actions and retained views.               | Old protected view/control retired; no previous-account content rendered after switching.                                                            |
| SEC-09 | M     | Fail protected upload, settings save and provider auth; inspect error/Raw/log displays.                          | Meaningful bounded diagnostics without echoing private request bodies or credentials.                                                                |
| SEC-10 | —     | Export/import recovery in disposable context, then use wrong/corrupt material.                                   | Correct custody recovers original data; bad custody fails explicitly without resetting server or replacing account keys.                             |

## SET — settings, logs, usage and analytics

Enumerate every current Global and Project Settings category during execution.
The source inventory includes General, Computer Use, Remote Desktop, Appearance,
Code, Usage, Models, Tasks, Workers, Logs, Tunnels, Workspaces, Policy, Skills
and MCP. Elite/Pro presentation controls live under Appearance; native-only
entries must remain explicit.

| ID     | Needs | Browser procedure                                                                                           | Expected observations                                                                                        |
| ------ | ----- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| SET-01 | —     | Visit every Global/Project Settings category; search exact label/keyword, multiword and unmatched query.    | Correct destination/search/no-results; no inaccessible category or stale project-scoped content.             |
| SET-02 | —     | Change System/Light/Dark, contrast, gutters/tab display and workspace first-open profile; reload.           | Preferences persist in correct account/device scope; new surface placement follows selected profile.         |
| SET-03 | —     | Enable/tune/disable Elite effects and reduced-motion setting where exposed; inspect menus/dialogs.          | Effects respect controls/limits; text/focus/click targets remain usable; disabled effects stop.              |
| SET-04 | —     | Open Logs for client/server/worker, filter level/text/correlation and change source.                        | Availability honest; no source mixing; no dropped scroll/frozen filter after live updates.                   |
| SET-05 | —     | Pause/resume follow, scroll older logs, load more, clear filter and export/copy.                            | Incremental bounded updates; user scroll preserved; exported scope/format correct and sanitized.             |
| SET-06 | W     | Select remotely linked worker logs; disconnect/reconnect it.                                                | Correct account/worker source through server; errors distinguish offline from empty logs.                    |
| SET-07 | —     | Open Usage; generate QA attachments and relay traffic, wait for actual meter flush/reconciliation, refresh. | Server storage, worker attachment estimate and UTC-day bandwidth are separate; measurements have timestamps. |
| SET-08 | —     | Change usage history range, inspect empty/loading/error and UTC boundary labels.                            | Accurate units/time bucketing; no entitlement enforcement claimed by informational meters.                   |
| SET-09 | M     | Open project token usage/provider analytics after known turns; change filters/period/provider.              | Root/subagent/model attribution and totals coherent; unknown data is explicit, not false zero.               |
| SET-10 | —     | Open worker network graph/live traffic; change selection and resize.                                        | Real runtime status/rates; graph remains interactive and labels readable.                                    |
| SET-11 | —     | Save settings in one client and inspect another; change a device-only tab color separately.                 | Account settings synchronize; intentionally per-device appearance does not incorrectly become global.        |
| SET-12 | N     | Inspect Pro Mode/transparency/native update controls on supported OS, then compare browser.                 | Platform-specific controls/appearance honest; no dead desktop action in browser.                             |

## UX — responsive, keyboard and visual QA

Run at approximately 1440×900, 1024×768, 768×1024 and 390×844. Record actual
viewport and browser zoom. If the tool cannot resize, use another supported
browser surface; do not claim native phone coverage from CSS emulation.

| ID    | Needs | Browser procedure                                                                                | Expected observations                                                                                           |
| ----- | ----- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| UX-01 | —     | At each size navigate project/Chat/Settings, open mobile selector/surface picker and long lists. | Reachable navigation, safe scroll, no clipped primary action or horizontal page overflow.                       |
| UX-02 | —     | Open nested/context menus/dialogs near viewport edges; dismiss via Escape/outside click.         | Correct placement, focus trap/return and scroll containment; no invisible blocking overlay.                     |
| UX-03 | —     | Keyboard Tab/Shift-Tab/Enter/Space through picker, settings, modal and destructive review.       | Visible focus; usable labels; focus does not enter hidden retained surface.                                     |
| UX-04 | —     | Use 200% browser zoom and long Unicode names/content.                                            | Controls wrap/truncate intentionally; full names/content accessible; primary actions remain reachable.          |
| UX-05 | —     | Compare light/dark/high contrast across chat/code/diffs/disabled/error states.                   | Legible text/selection/borders; no unreadable code or invisible selected tab.                                   |
| UX-06 | —     | Scroll transcript, Tasks/Trajectory, settings and nested diff with pointer over child controls.  | Intended container scrolls; no trapped wheel or involuntary jumps to latest.                                    |
| UX-07 | —     | Select/copy real content versus decorative UI text; use clipboard controls.                      | Useful content selectable/copyable; decorative dragging does not break layout.                                  |
| UX-08 | —     | Narrow Git drawers/Inspect/task editors; resize back to wide.                                    | Drawer/focus/selection adapt without losing current file/event/Task.                                            |
| UX-09 | C,D   | Use supported browser touch emulation on streamed canvas; scroll/tap/double-tap.                 | Correct advertised touch mapping; tool limitations distinct from product defect.                                |
| UX-10 | N     | Use actual mobile keyboard/command bar, rotation, background/resume and native camera picker.    | Insets/Esc/Shift/arrows and uploads usable; record iOS/Android results separately.                              |
| UX-11 | —     | Rapidly double-click submit/create/save and navigate while pending.                              | One operation or explicit idempotent outcome; no modal lock or wrong-resource mutation.                         |
| UX-12 | —     | Inspect empty/loading/offline/error/retry states in each completed feature family.               | No misleading empty-success state; messages identify useful next action without leaking implementation secrets. |

## NATIVE — supplemental platform qualification

These are planned tests, not browser-pass substitutes. Browser baseline should
still verify correct omission/disabled treatment of native-only actions.
Run only in a separate explicitly identified native QA installation.

| ID        | Needs | Procedure                                                                                                    | Expected observations                                                                                 |
| --------- | ----- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| NATIVE-01 | N     | Start named disposable desktop profile; close/reopen and inspect worker/server identity.                     | Stable identity/storage; services owned/stopped correctly; no personal-profile reset.                 |
| NATIVE-02 | N     | Exercise pop-outs/reveal/tunnels using NAV/EXP/TUN cases.                                                    | Actual OS windows/mounts/listeners; single ownership and correct cleanup.                             |
| NATIVE-03 | N     | Check offered update, inspect history/download/error/cancel; install only into disposable test installation. | Accurate version/channel/progress; restart retains data/identity; no production install replacement.  |
| NATIVE-04 | N     | Open synthetic build settings, select pinned commit, prepare, cancel/build and inspect progress/cache.       | Explicit commit/trust/review; actual artifact or actual failure; no source/build performed on server. |
| NATIVE-05 | N     | Install a completed synthetic build in dedicated QA installation and restart.                                | Verified artifact/identity/compatibility; failed build is never reported as installed.                |
| NATIVE-06 | N     | macOS menus/tray/drag/titlebar/Pro Mode; Windows paths/reveal/update; Linux supported shell.                 | Correct platform behavior; each OS result separately identified.                                      |
| NATIVE-07 | N     | Physical iOS and Android: sign-in QR, attachment picker, terminal keyboard, app resume.                      | Real hardware permissions/lifecycle tested; responsive web result does not stand in.                  |

## SITE — public frontend smoke

| ID      | Needs | Browser procedure                                                 | Expected observations                                         |
| ------- | ----- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| SITE-01 | S     | Start `pnpm site` in owned session; open `http://127.0.0.1:5174`. | Real marketing page renders without runtime errors.           |
| SITE-02 | S     | Visit navigation/feature/download links at wide/narrow widths.    | Correct destinations and no broken internal anchors/overflow. |
| SITE-03 | S     | Inspect platform/version download choices without installing.     | Labels/links match offered artifacts; failure is actionable.  |
| SITE-04 | S     | Compare theme/effects/reduced motion and keyboard navigation.     | Legible accessible controls; no effect layer blocking links.  |

## SOAK — combined journeys and sustained behavior

Use browser observations plus owned process/log measurements. Timing/memory
numbers are observations, not performance claims without a comparable baseline.

| ID      | Needs | Browser procedure                                                                                                                     | Expected observations                                                                                 |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| SOAK-01 | M,C   | For 30 minutes alternate two projects, active Agent, Explorer draft, terminal, Code, Tasks and Browser; sample state every 5 minutes. | No steadily growing attachment/process/error storm; responsive interaction and retained drafts.       |
| SOAK-02 | M     | Queue three harmless Tasks, run ordinary Agent/terminal in parallel, visit Settings and return.                                       | Scheduler capacity independent of view; foreground work remains usable; no hidden Task polling storm. |
| SOAK-03 | M,C   | Repeat server restart, worker restart and client reload twice across mixed live surfaces.                                             | Each recovers through correct snapshot/generation; no escalating duplicates or phantom resources.     |
| SOAK-04 | M,G   | Complete end-to-end QA feature branch: Agent edit → Explorer inspect → Run → Git stage/commit → sandbox PR review.                    | Same intended source/content throughout; UI mutation results agree with worker/GitHub state.          |
| SOAK-05 | A,W   | Switch accounts/servers while streams and drafts exist; reopen each after all finish.                                                 | No cross-identity content/control; durable histories and legitimate drafts preserved.                 |

## Defect reporting to the tracker

The real tracker is [ArcaneArts/Cantrip issues](https://github.com/ArcaneArts/Cantrip/issues).
The user has authorized filing defects found during WQA. Every FAIL and every
product-caused BLOCKED result must link a newly created issue or a matching
existing issue. Also file persistent unexplained application failures as
investigation issues; label uncertainty rather than inventing a root cause.

1. Preserve screenshot and actual UI/service error before navigating/retrying.
2. Search open and closed issues by symptom and affected component. A WQA title
   prefix alone is insufficient: an existing bug may not use it. Deduplicate
   the same root problem across tests; keep all affected IDs in the ledger.
3. Reproduce once safely if possible. An intermittent or destructive failure
   still merits an issue with exact observed frequency and uncertainty.
4. Create a focused issue per independent problem. State expected and actual
   behavior, exact steps, profile/fixture, commit/browser/OS, impact, frequency
   and recovery attempts. Separate dependency/tool blocks from app defects.
5. Use only existing appropriate labels if available; labels are optional and
   must not prevent issue creation. Do not invent success, crash causes or
   security guarantees from source inspection.
6. Link issue URL immediately in the case ledger. If tracker submission itself
   fails, save the exact issue body privately, record the real error and retry
   later; report the unfiled backlog explicitly.

Suggested priority language: P0 data loss/security/isolation; P1 blocked core
workflow; P2 functional defect with workaround; P3 visual/polish. Use the
repository's existing priority conventions when present.

```markdown
Title: [WQA][<area>] <specific observed failure>

Cases: <case IDs>
Revision: <commit>
Environment: <OS, browser/version, viewport, app/server/worker versions>
Profiles/fixtures: <B/M/A/... and QA fixture only>

Steps to reproduce:

1. ...
2. ...

Expected:
...

Actual:
...

Frequency and impact:
...

Evidence:

- <sanitized screenshot or attached public artifact>
- <bounded event/error codes, correlation IDs and relevant timestamps>

Recovery attempted:
...

Source touchpoints (suspected, not asserted root cause):
...
```

CLI workflow, from an owned QA shell with a completed body file:

```sh
gh issue list --repo ArcaneArts/Cantrip --state all --search "<symptom keywords>" --limit 50
gh issue create --repo ArcaneArts/Cantrip --title "[WQA][area] Concrete failure" --body-file /absolute/path/to/issue.md
```

Preserve real newlines using `--body-file`. Private filesystem screenshot paths
are not public issue attachments; attach a sanitized artifact through an
available supported mechanism or describe the evidence and retain the private
path in the campaign report. Never publish credentials, recovery files,
private source, raw protected payloads or full unsanitized service logs.

## Evidence, completion report and cleanup

Keep evidence outside tracked sources, grouped by case. Recommended layout:

```text
evidence/
  manifest.md
  results.csv
  report.md
  cases/AGENT-05/
    before.png
    paused.png
    resumed.png
    observation.md
    sanitized-service-events.txt
  issues/
    AGENT-05.md
```

The final report must include:

- Exact tested commit, commands, runtime/browser/OS and available profiles.
- Planned/applicable/executed totals; PASS/FAIL/BLOCKED/NOT RUN/NOT APPLICABLE
  counts by section/profile, with no omitted cases disguised as passing.
- New issue links, existing issue links, affected cases and any unfiled backlog.
- Remaining native/topology/provider/permission/tool coverage and concrete
  reason for each block.
- Reproduction notes for intermittent failures and recovery/soak observations.
- Artifact location and cleanup state.

This is a QA coverage report, not a fabricated release gate. Missing optional
coverage does not erase completed browser evidence, and a passing smoke test
does not establish the wide campaign passed.

Cleanup only resources owned by this run:

1. Disable/delete QA automations and stop Tasks/Goals/services/Runs before
   closing their views. Stop F6 and owned terminal processes.
2. Close QA Browser/Remote Desktop/CUA sessions, release tunnels/shares and
   confirm native input buttons/keys are no longer held.
3. Close sample issues/PRs/Actions and remove sandbox branches/releases as
   appropriate. Keep real defect issues open. Do not delete evidence needed
   for reproduction.
4. Unlink user-owned fixture folders/repositories through normal UI; use
   confirmed owned-folder deletion only for the explicitly disposable roots.
   Record anything intentionally retained.
5. Stop owned dev sessions and account Docker stack; remove only QA-created
   workers/accounts/storage according to their normal lifecycle.
6. Preserve evidence outside any worktree to be archived. Follow the manual
   protocol for any later documentation/code edits; never clean/reset another
   user's checkout or worktree.


## Campaign results

- [2026-10-08 Wide QA campaign](WQA-2026-10-08.md): 394 dispositions, section counts, defect-to-test mapping, skipped coverage and fixture cleanup.
