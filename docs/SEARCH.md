# Worker-Managed Search and Web Runtime

## Status

This document describes the implemented system that gives Cantrip agents reliable
web search, static page reading, and browser-backed research without paid
search APIs or host-level prerequisite installation.

The worker installs and uses its own portable SearXNG, Playwright, and Chromium
runtimes. It continuously supervises SearXNG and starts browser processes only
when rendered browsing needs them. It must not discover, reuse, update, or
modify copies already installed on the host. Docker, system Python, global npm
packages, Homebrew, `apt`, `winget`, and equivalent package managers are not
prerequisites and are never invoked as a fallback.

This follows the worker ownership and managed-runtime model already established
by [CodeGraph](CODEGRAPH.md), while exposing the resulting operations through
the worker-owned [Cantrip MCP](MCP.md). Cantrip Server remains the durable
authorization and routing control plane; search execution, page content,
browser state, and disposable runtime caches remain on the assigned worker.

## 1. Decision

Cantrip will provide three related capabilities:

1. **Web search** through a worker-supervised portable SearXNG process.
2. **Static page reading** through a hardened Node-based fetch and readability
   pipeline bundled with `cantrip_worker`.
3. **Rendered and interactive browsing** through a worker-supervised portable
   Playwright and Chromium runtime.

The managed Cantrip MCP will expose a small purpose-built tool catalog instead
of injecting the complete upstream Playwright MCP server. This keeps schemas
small, preserves the existing binding and permission model, and lets Cantrip
apply consistent network, encryption, result-size, and lifecycle policies.

The portable runtimes are host-wide worker resources, not project resources.
One worker may serve many authorized agent lanes, but every request remains
bound to its owner, chat, execution lane, permission profile, and current
worker generation.

### Agent surface profiles

Cantrip uses one managed MCP server implementation with two catalog profiles:

- standalone Chat receives exactly `tool_help`, `web_search`, and `web_read`;
- IDE/project agents receive the complete managed Cantrip MCP catalog,
  including search, reading, and interactive web-session tools.

The worker injects the managed server into both surfaces. A discriminated
binding prevents standalone Chats from carrying project or worktree authority,
and the broker, server, tool discovery, and `tool_help` all enforce the active
profile. Cantrip disables Codex's hosted native web search through the common
generated runtime configuration for every provider, leaving the worker-managed
path as the single search implementation exposed to agents.

## 2. Goals

- Give every eligible Cantrip agent consistent search and web-reading tools
  without a paid search API key.
- Work when the host has no SearXNG, Python, Playwright, or Chromium installed.
- Ignore matching software already installed on the host.
- Install only beneath worker-owned storage and never mutate the host's normal
  environment, package database, browser profiles, or global configuration.
- Download exact signed and checksummed OS/architecture artifacts, validate
  them before promotion, and retain the previous verified version for rollback.
- Keep search queries, fetched content, browser profiles, screenshots, and
  credentials off Cantrip Server and out of plaintext logs.
- Bound network access, result sizes, processes, browser contexts, memory,
  concurrency, caches, and retry behavior.
- Degrade independently: failed search or browser setup must not prevent the
  worker, terminals, projects, or ordinary agent tools from functioning.
- Make install, health, failure, retry, update, and rollback state visible
  without showing a prerequisite screen or asking the user to install tools.

## 3. Non-goals

- Building or operating a Cantrip-hosted public search engine.
- Using public SearXNG instances as the production default.
- Installing Docker or Podman on a worker.
- Running `pip install`, `npm install`, Playwright `install-deps`, or an OS
  package manager against the host at runtime.
- Reusing a user's Chrome, Edge, Chromium, Playwright, Python, SearXNG, cookies,
  extensions, or profiles.
- Exposing arbitrary browser JavaScript evaluation in the initial tool set.
- Allowing Cantrip Server, a project, an agent, or an app request to choose a
  managed-runtime filesystem path.
- Guaranteeing execution on kernels or operating-system ABIs older than
  Cantrip's published worker compatibility baseline.

## 4. Architecture

```text
Codex App Server
    │ MCP over process-local STDIO
    ▼
worker: managed Cantrip MCP
    │ authenticated random loopback broker
    ▼
worker: bound web operation adapter
    ├─ web_search ────────────────┐
    │                            ▼
    │                   portable SearXNG child
    │                            │
    │                            ▼
    │                   external search engines
    │
    ├─ web_read ──► hardened HTTP fetch ──► readability extraction
    │                    │
    │                    └─ render escalation ─┐
    │                                         ▼
    └─ web_session_* ───────────────► portable Playwright/Chromium
                                              │
                                              ▼
                                         external sites
```

Search and page traffic leave the worker directly. They do not proxy through
Cantrip Server. Tool activity uses the same protected agent-activity path as
other MCP calls, following [the encryption model](ENCRYPTION.md). The model
provider necessarily receives the tool inputs and bounded results used by the
agent, but Cantrip's relay and logs must not gain a new plaintext copy.

Client-visible browser focus or navigation may use the existing authenticated
worker → server → client live control route. Search, extraction, accessibility
snapshots, cookies, and browser process control do not use that route.

## 5. Worker-owned runtime layout

The worker resolves an implementation-owned root below its private data
directory. The following is logical layout rather than a server-supplied path:

```text
<worker-data>/managed-runtimes/
├── manifests/
│   ├── searxng.json
│   └── playwright.json
├── searxng/
│   ├── current.json
│   ├── versions/
│   │   └── <bundle-version>/
│   │       ├── python/
│   │       ├── app/
│   │       ├── config-template/
│   │       ├── launcher/
│   │       └── licenses/
│   ├── config/
│   ├── cache/
│   └── state/
└── playwright/
    ├── current.json
    ├── versions/
    │   └── <bundle-version>/
    │       ├── package/
    │       ├── browsers/
    │       ├── libraries/
    │       ├── fonts/
    │       └── licenses/
    ├── profiles/
    ├── downloads/
    ├── cache/
    └── traces/
```

Versions are immutable after promotion. Mutable configuration, profiles, and
caches live outside version directories so rollback never adopts a partially
installed executable tree. All path resolution rejects symlinks, traversal,
unexpected ownership, and roots outside worker storage.

POSIX roots are chmod `0700` and ownership-checked. On Windows the current
implementation validates directory/non-symlink confinement and relies on the
worker account and storage ACLs; it does not install an explicit ACL. Browser
profiles receive a stricter logical boundary than disposable package and search
caches.

## 6. Artifact production and manifest

Cantrip release CI builds complete runtime artifacts for every supported
worker tuple:

- macOS ARM64 and x64;
- Windows ARM64 and x64; and
- Linux ARM64 and x64.

An artifact is published only when that tuple passes offline launch, real
loopback health, search or browser smoke, process-tree shutdown, and license
inventory checks. Unsupported tuples remain explicit instead of falling back
to a system installation.

Each release manifest includes at least:

```ts
interface ManagedRuntimeArtifact {
  schemaVersion: 1;
  component: "searxng" | "playwright";
  version: string;
  platform: "darwin" | "win32" | "linux";
  architecture: "arm64" | "x64";
  archiveFormat: "tar.gz" | "zip";
  downloadUrl: string;
  sha256: string;
  signature: string;
  signingKeyId: string;
  compressedBytes: number;
  extractedBytes: number;
  licenseManifest: string;
  sourceManifest: string;
  minimumOs?: string;
  minimumKernel?: string;
  minimumLibc?: string;
}
```

The release channel pins SearXNG, CPython, Python dependencies, Playwright,
Chromium, native libraries, and fonts as one tested compatibility unit. The
worker never resolves `latest` independently from PyPI, npm, or a browser
download service.

## 7. Installation, promotion, update, and rollback

The worker uses one serialized installer per component:

1. Select the exact manifest entry for the worker tuple.
2. Reuse the current verified runtime when its manifest still matches.
3. Download into a bounded `.partial` file beneath worker storage.
4. Validate declared and actual compressed size before extraction.
5. Verify the digest, signature, component, platform, architecture, and version.
6. Extract into a unique staging directory using traversal, link, file-count,
   and expanded-size limits.
7. Validate the expected runtime inventory and executable paths.
8. Run an offline launch probe with worker-private environment variables.
9. Start the candidate and perform a real loopback health check.
10. Atomically replace `current.json` only after the health check succeeds.
11. Retain the last verified version and atomically roll back when the promoted
    candidate repeatedly fails.
12. Remove older unreferenced versions and stale partial directories in a
    bounded background cleanup.

Install state is replayable after a crash. A partial download, extraction, or
health check never becomes current. File locks and in-process coordination
prevent simultaneous agents or worker restarts from racing promotion.

The worker checks the Cantrip-owned release manifest during startup and on a
bounded periodic schedule. Updates do not interrupt an active agent tool call
or browser context. A new runtime becomes eligible only at a safe process
boundary; existing sessions drain on the previous version.

## 8. Portable SearXNG runtime

### 8.1 Bundle contents

The SearXNG artifact contains:

- a pinned redistributable CPython build;
- the exact pinned SearXNG source and installed application;
- the complete locked Python dependency graph and native extension wheels;
- a small Cantrip-owned loopback launcher and readiness endpoint;
- a generated-settings template and CA bundle;
- platform runtime libraries required by bundled extensions; and
- complete license, notice, source, and software-bill-of-materials records.

Runtime installation never compiles Python extensions on the worker. All
native wheels and runtime libraries are resolved and tested in release CI.
Windows bundles include their local Visual C++ runtime files rather than
requiring a system redistributable. Linux artifacts define and test a minimum
kernel and libc baseline. Portability means no host package mutation; it does
not make a Chromium or CPython process independent of the host kernel ABI.

### 8.2 Process and configuration

The worker starts one SearXNG child for the host after enrollment and runtime
preparation. It uses a random loopback port, a generated secret, a private
`HOME`, private temp/cache roots, and no inherited user package configuration.

The generated settings enable JSON output and deliberately keep the service
private:

```yaml
search:
  formats:
    - json
  safe_search: 1
  max_page: 5

server:
  bind_address: "127.0.0.1"
  port: <worker-selected-random-port>
  limiter: false
  public_instance: false
  secret_key: <worker-generated-secret>
  image_proxy: false

valkey:
  url: false
```

The initial implementation does not bundle or run a Valkey server. A private
loopback instance does not need public-instance bot detection, and Cantrip can
apply a smaller bounded result cache in the worker adapter. A future need for
Valkey requires its own portable artifact and process lifecycle; it cannot
silently become a host prerequisite.

Cantrip maintains a curated default engine set with no paid API keys. Engine
failures, CAPTCHA responses, and rate limits are independent partial failures:
the adapter returns available results, engine diagnostics, and a bounded
degraded signal instead of treating one upstream outage as total failure.

### 8.3 Supervision

The process runs in its own POSIX process group or Windows Job Object. The
worker applies bounded exponential restart backoff, transitions to degraded
after repeated failures, and rolls back when failures follow a promotion.
Worker shutdown first requests graceful exit, then terminates the entire
process tree after a short deadline. Startup removes or terminates only
worker-owned orphan state proven to belong to this runtime generation.

SearXNG installation or failure never prevents the worker from becoming
available. Search tools report `installing`, `temporarily-unavailable`,
`runtime-unsupported`, or `degraded` with an actionable retry boundary rather
than inviting the agent to install packages.

### 8.4 Licensing

SearXNG is AGPL-3.0-or-later. Every redistributed bundle must include the exact
corresponding source, Cantrip patches, reproducible build inputs, notices, and
a durable source location. License and source compliance is a release gate,
not a post-install task delegated to the worker.

## 9. Static fetch and readability pipeline

Static reading is implemented in the TypeScript worker and packaged through
the normal Cantrip build. It may use bounded libraries for DOM parsing,
readability extraction, robots parsing, and optional PDF text extraction, but
it introduces no separately installed runtime.

The fetcher:

- accepts only `http:` and `https:` URLs;
- resolves and validates DNS before every connection;
- rejects loopback, private, link-local, multicast, unspecified, and cloud
  metadata destinations;
- revalidates every redirect destination and detects rebinding;
- applies connection, first-byte, total, redirect, compressed-byte, expanded-
  byte, and content-type limits;
- sends no ambient cookies, user credentials, or system browser state;
- obeys robots policy for autonomous reads;
- extracts a canonical title, URL, text/Markdown body, and retrieval time; and
- pages large output with opaque cursors instead of dumping a document into one
  model result.

When a static response is empty, script-gated, or structurally unusable and the
caller selected automatic rendering, the adapter escalates to the managed
Playwright runtime. It does not use rendering merely because a page contains
JavaScript.

## 10. Portable Playwright and Chromium runtime

### 10.1 Bundle contents and compatibility

The Playwright artifact contains:

- exact pinned `playwright-core` code;
- its matching Chromium and headless Chromium revisions as needed;
- the Linux shared-library closure used by those binaries;
- a portable fontconfig configuration and baseline font set;
- CA certificates and platform launch wrappers; and
- license, notice, source, and SBOM records.

The worker launches this package with Cantrip's own bundled Node runtime. It
never invokes a system `node`, `npx`, npm cache, Playwright cache, Chrome, Edge,
or Chromium installation. `PLAYWRIGHT_BROWSERS_PATH` and all cache/profile
variables point exclusively into worker storage.

Playwright and browser revisions are promoted as a single unit. No component
can update itself. Candidate health includes launching the packaged browser,
loading a deterministic local page, reading an accessibility snapshot, and
closing the complete process tree.

### 10.2 Linux dependency closure

Linux release CI starts from Cantrip's oldest supported runtime baseline,
collects the required browser shared-library closure, copies the approved
libraries and fonts into the artifact, and validates the artifact in a clean
environment without installing packages.

The launcher sets child-only paths such as:

```text
LD_LIBRARY_PATH=<runtime>/libraries
FONTCONFIG_PATH=<runtime>/fonts
PLAYWRIGHT_BROWSERS_PATH=<runtime>/browsers
HOME=<worker-runtime-state>
XDG_CACHE_HOME=<worker-runtime-cache>
```

Nothing is copied into `/usr`, `/lib`, `/etc`, a global browser directory, or
the user's normal cache. An unsupported kernel/libc baseline produces an
explicit unsupported status and never triggers host repair.

Chromium sandbox support is validated. Cantrip must not silently add
`--no-sandbox`. If an operator-facing override is introduced later, it must be
explicit, strongly warned, policy-controlled, and excluded from the secure
default.

### 10.3 Browser process model

Runtime preparation is eager with the worker, but Chromium starts lazily when
a rendered read or interactive web session first needs it. The worker maintains
a small bounded browser pool and:

- creates isolated ephemeral contexts for ordinary research;
- partitions persistent profiles by owner and explicit Browser surface;
- never imports a system browser profile;
- closes idle or abandoned contexts;
- caps browser processes, contexts, pages, downloads, traces, memory pressure,
  and concurrent navigations;
- blocks filesystem navigation and extension/custom schemes;
- stores downloads and traces in bounded worker-owned directories; and
- terminates every descendant on shutdown or generation replacement.

Authenticated browsing is explicit. A research context receives no cookies. A
user-owned persistent Cantrip Browser may retain its own worker-local profile,
but those credentials are never copied to another owner, project, or ephemeral
agent context.

## 11. Managed MCP tool contract

These tools join the existing managed Cantrip MCP catalog and use its generated
schemas, examples, annotations, binding validation, permission narrowing,
payload limits, and `tool_help` behavior.

### `web_search`

```ts
interface WebSearchInput {
  query: string;
  count?: number;
  page?: number;
  freshness?: "day" | "month" | "year";
  language?: string;
  category?: "general" | "news" | "science" | "it";
  safeSearch?: "off" | "moderate" | "strict";
  includeDomains?: string[];
  excludeDomains?: string[];
}
```

The result contains a normalized query, bounded result rows, a short-lived
opaque result ID, title, canonical URL, snippet, contributing engines,
optional publication time, partial-engine diagnostics, and truncation state.
Search never returns full page bodies.

### `web_read`

```ts
interface WebReadInput {
  url?: string;
  searchResultId?: string;
  cursor?: string;
  maxChars?: number;
  render?: "never" | "auto" | "always";
}
```

Exactly one of `url` or `searchResultId` is accepted on the first page. The
result includes the canonical URL, title, bounded Markdown/text, extraction
method, retrieval time, continuation cursor, and truncation state. `auto`
performs static extraction first and renders only when necessary.

### Interactive session tools

The initial browser interaction surface is deliberately small:

- `web_session_open` creates or resumes one bound isolated session and
  navigates to an allowed URL;
- `web_session_snapshot` returns a bounded accessibility snapshot;
- `web_session_click` clicks one exact reference from the current generation;
- `web_session_type` types bounded text into one exact reference, optionally
  submitting it; and
- `web_session_close` releases the session and its ephemeral state.

Session and element references are opaque, generation-fenced, owner-bound, and
short-lived. Tools reject stale references rather than guessing. Arbitrary
JavaScript, unrestricted file upload, credential extraction, and unbounded DOM
or screenshot output are not part of the first version.

Search and reading are annotated read/open-world. Navigation, clicking,
typing, downloads, and form submission are open-world mutations. Permission
profiles and policy may omit interactive tools while retaining search/read.

## 12. Security and privacy boundaries

The [hosted security architecture](HOSTED_SECURITY_ARCHITECTURE.md) continues
to apply. The implementation additionally requires:

- SSRF defenses before connection and after every redirect;
- explicit outbound URL, DNS, response, decompression, and concurrency budgets;
- no access to worker loopback services, private networks, cloud metadata, or
  project files through either fetch or Chromium;
- no ambient proxy credentials unless an authorized worker configuration
  explicitly supplies a protected proxy;
- isolated browser contexts and owner-partitioned persistent profiles;
- no plaintext queries, URLs, snippets, page bodies, snapshots, screenshots,
  cookies, form values, or credentials in server or worker logs;
- metrics limited to component version, status class, duration, byte counts,
  result counts, and coarse failure categories;
- encrypted tool input/result persistence wherever existing agent activity is
  durable; and
- bounded worker-local caches with expiry and explicit clear operations.

SearXNG still sends queries to configured external engines, and page reads send
requests to external sites. The UI and documentation must not describe
worker-local execution as preventing those destinations from receiving normal
network metadata.

## 13. Runtime inventory, settings, and UI

The worker advertises rolling-compatible health for two immutable managed
components:

```text
Web Search — SearXNG
Version: <version>
Status: Checking | Installing | Updating | Ready | Degraded | Failed | Unsupported
Managed by Cantrip · Portable worker runtime

Web Browser — Playwright + Chromium
Version: <version>
Status: Checking | Installing | Updating | Ready | Degraded | Failed | Unsupported
Managed by Cantrip · Portable worker runtime
```

The app receives only bounded health, progress, version, retryability, and
failure-category metadata. It does not receive runtime paths, process IDs,
queries, URLs, or page content.

Available user actions are retry installation, check for update, reinstall the
current version, view bounded diagnostics, clear disposable caches, and clear
persistent browser profiles with confirmation. Managed entries cannot be
edited, disabled by shadowing their reserved names, pointed at system
executables, or copied into user MCP configuration.

Release, compatibility, licensing, cache, operator-action, and incident
procedures are maintained in [Managed web runtime operations](MANAGED_WEB_RUNTIMES.md).

There is no prerequisite screen. Installation begins in the background, and a
tool invoked during first setup returns bounded installing/progress state. The
agent is instructed to continue independent work or retry after readiness, not
to run package-manager commands.

## 14. Failure and edge-case behavior

| Condition                                          | Required behavior                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Interrupted download or extraction                 | Preserve current runtime; discard bounded partial state on recovery.                                  |
| Digest, signature, or inventory mismatch           | Reject candidate, retain prior version, emit security-class diagnostic.                               |
| Candidate fails health check                       | Never promote it; continue prior runtime.                                                             |
| Promoted version repeatedly crashes                | Atomically roll back and quarantine the failed version.                                               |
| SearXNG engine CAPTCHA/rate limit                  | Return other results and bounded partial diagnostics.                                                 |
| All search engines unavailable                     | Return degraded/unavailable without suggesting a host install.                                        |
| Static page is script-only                         | Escalate only when rendering is allowed and Playwright is healthy.                                    |
| Chromium runtime is unavailable                    | Static fetch and search remain available.                                                             |
| Host misses supported kernel/libc/sandbox baseline | Mark browser unsupported; never install host libraries or silently disable sandboxing.                |
| Worker exits during active browser work            | Cancel calls, kill the owned process tree, and expire all session references.                         |
| Worker restarts with stale processes               | Reclaim only processes proven to belong to its managed runtime generation.                            |
| Disk budget is exceeded                            | Preserve current and rollback versions; evict caches, traces, partials, and older versions first.     |
| Multiple owners use one worker                     | Share immutable executables only; partition requests, caches where sensitive, sessions, and profiles. |
| A system SearXNG/Chrome/Playwright is present      | Ignore it completely.                                                                                 |

## 15. Implementation record

The system was delivered as independently mergeable manual-change cycles with
their own worktrees, pull requests, auto-merge observation, and cleanup. The
following phases record the implemented architecture and release work.

### Phase 1 — managed runtime foundation

- Define signed manifest, health, install-progress, failure, and rolling worker
  capability schemas.
- Implement selection, download, size/digest/signature verification, safe
  extraction, staging, promotion, locks, rollback, and cleanup.
- Add bounded settings inventory without exposing worker paths.
- Reuse common supervision and process-tree shutdown primitives.

### Phase 2 — SearXNG build and release pipeline

- Produce pinned portable CPython/SearXNG artifacts for the platform matrix.
- Lock native wheels and include Windows/Linux runtime dependency closure.
- Add the private launcher, settings template, readiness endpoint, SBOM,
  notices, corresponding source, and reproducible build inputs.
- Gate publication on clean-host launch, loopback API, search, shutdown, and
  rollback smoke tests.

### Phase 3 — SearXNG worker manager

- Install and supervise the host-wide child below worker storage.
- Generate private configuration and random loopback binding.
- Add health, restart, update, rollback, cache, shutdown, and diagnostics.
- Advertise capability independently from general worker readiness.

### Phase 4 — search and static reading

- Implement the hardened Node fetch/readability pipeline.
- Add `web_search` and `web_read` schemas, help examples, annotations, binding
  permissions, rate limits, protected results, and partial failure semantics.
- Add citation metadata and bounded continuation cursors.
- Verify SSRF, rebinding, redirects, compression bombs, oversized content,
  cancellation, and plaintext-log exclusion.

### Phase 5 — Playwright build and release pipeline

- Produce pinned `playwright-core` plus matching Chromium artifacts.
- Capture Linux shared libraries, fonts, CA material, launch wrappers, SBOM,
  and licenses without host installation.
- Gate publication on local-page navigation, accessibility snapshot, isolation,
  sandbox availability, and complete process-tree cleanup.

### Phase 6 — Playwright worker manager

- Install and validate the portable browser runtime.
- Implement lazy browser startup, bounded pooling, isolated contexts,
  owner-partitioned profiles, resource limits, shutdown, update draining, and
  rollback.
- Keep browser health independent from search and static reading health.

### Phase 7 — rendered reading and interaction

- Add `web_read` render escalation.
- Add the five curated `web_session_*` tools with generation-fenced references.
- Integrate explicit persistent Browser profiles and existing client-focus
  controls without exposing browser state to the server.
- Validate authenticated, unauthenticated, concurrent, stale-reference,
  cancellation, and hostile-page behavior.

### Phase 8 — settings, operations, and hardening

- Add immutable managed-runtime presentation, progress, retry, reinstall,
  cache/profile cleanup, and bounded diagnostics.
- Document release/update operations, compatibility baselines, licensing,
  cache budgets, and incident rollback.
- Run multi-worker, multi-owner, offline-start, slow-network, corrupted-update,
  and shutdown acceptance passes.

## 16. Validation strategy

Validation should be proportional within each phase, with a small set of
cross-platform acceptance fixtures reused by CI and local worker tests:

- deterministic SearXNG health and JSON result normalization;
- partial engine failure and total upstream failure;
- static HTML, redirects, Unicode, large pages, robots denial, and PDFs;
- SSRF attempts through literals, DNS, redirects, alternate encodings, and
  rebinding;
- JavaScript-rendered pages and bounded accessibility snapshots;
- stale browser references, isolated cookies, parallel owners, and profile
  partitioning;
- interrupted downloads, corrupted archives, zip-slip/tar traversal, rollback,
  and concurrent installation;
- graceful and forced worker shutdown with no surviving managed descendants;
- install and execution with system Python, SearXNG, Playwright, and Chrome
  absent; and
- install and execution with conflicting system copies present, proving those
  copies are ignored.

CI artifact tests must run in clean images or machines that do not contain the
target packages. Tests may inspect system process, filesystem, package-manager,
and user-cache state before and after to prove that the portable install did
not mutate the host.

## 17. Acceptance criteria

The feature is complete when:

1. Search, static reading, rendered reading, and browser interaction work on
   every published worker tuple without global installation or administrator
   access.
2. SearXNG, Playwright, and Chromium execute exclusively from worker-owned
   versioned storage, even when conflicting system copies exist.
3. No installer invokes Docker, a system Python/Node/npm/pip, Playwright
   `install-deps`, or an OS package manager.
4. Runtime downloads are signed, checksummed, safely extracted, health checked,
   atomically promoted, and automatically rolled back.
5. Worker restart and shutdown leave no managed SearXNG or Chromium descendants.
6. A failed or unsupported browser preserves static search/read, and a failed
   search runtime preserves the rest of Cantrip.
7. Search queries, page content, snapshots, screenshots, cookies, credentials,
   profiles, and runtime paths do not enter plaintext server or worker logs.
8. Fetch and browser navigation cannot reach local services, private networks,
   cloud metadata, or arbitrary worker files.
9. Tool schemas, examples, validation errors, and runtime instructions are
   sufficient for an agent to use the tools without trial-and-error retries or
   package-install attempts.
10. The settings UI presents both runtimes as portable, immutable, managed by
    Cantrip, and independently healthy or degraded.
