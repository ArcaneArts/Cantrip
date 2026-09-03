# Hosted relay security architecture

- Status: protected authentication, owner enforcement, worker enrollment,
  account endpoint encryption, account/worker quotas, HTTP/proxy hardening,
  operational probes/metrics, owner-scoped security audit visibility,
  Redis-backed multi-instance relay routing, and database-fenced scheduler
  claims implemented
- Route inventory: [`security/server-route-inventory.json`](security/server-route-inventory.json)
- Regenerate: `pnpm audit:server-boundaries:write`
- Verify: `pnpm audit:server-boundaries`

## 1. Security objective

A hosted Cantrip server is a remote-code-execution control plane. An
application principal can route prompts, shell input, project-file and Git
operations, editor traffic, browser input, and desktop input to an enrolled
worker. Authentication and ownership are therefore execution boundaries, not
presentation concerns.

The server is the only authority and rendezvous point. WorkerLink may move
authorized ephemeral bytes directly between an app and worker after the server
binds the exact session and resource grant:

```mermaid
flowchart LR
    APP["Cantrip app"]
    API["Cantrip server"]
    DB["PostgreSQL"]
    BUS["Shared coordination layer"]
    WORKER["Account-owned worker"]
    FILES["Managed folders, repositories, PTYs, Codex, Code"]

    APP <-->|"authenticated HTTPS and WSS"| API
    API --> DB
    API <-->|"presence leases, routed envelopes, live fanout"| BUS
    WORKER -->|"outbound authenticated control and relay WSS"| API
    APP <-.->|"authorized WorkerLink LOCAL/LAN/WAN carriers"| WORKER
    WORKER --> FILES
```

The app never treats a candidate address or worker endpoint as authority; the
server-bound session, authenticated carrier handshake, and exact grant remain
authoritative. The server never dereferences a worker filesystem path. A worker
never treats a model-provider credential as a Cantrip enrollment credential.

### 1.1 Worker-owned managed MCP

The managed `cantrip` MCP process runs beside Codex on the account-owned worker,
not on Cantrip Server or in the app. Codex communicates with it only over
process-local STDIO. The MCP host reads an expiring connection document from a
worker-private directory and authenticates to a random loopback-only broker.
On POSIX hosts the directory is mode `0700` and the regular, non-symlink
document is mode `0600`; the host rejects unsafe permissions, ownership,
symlinks, non-loopback endpoints, malformed data, and expired bindings.

The binding fixes owner, project, chat, execution lane, worker, worktree,
permission profile, and allowed operations. The broker rechecks its random
credential, expiry, allowlist, payload limits, and concurrency limits. When an
operation reaches `/api/internal/agent-operations`, the server derives owner and
worker from the enrolled worker credential, loads the current chat lane, and
independently rejects mismatched, stale, expired, or unauthorized bindings.
Cross-worker surface operations remain server-routed. WorkerLink direct
carriers connect an authorized app to its selected worker, not workers to one
another.

Codex's enabled managed-tool list is narrowed to the binding permission
profile. Read-only profiles receive Run configuration/status/output tools but
not Run create/update/delete/start/restart/stop or secret-write tools; the
broker and server still enforce that distinction if a caller attempts to bypass
Codex discovery. Run lifecycle mutations require the stable configuration ID,
the expected shared-definition revision, and generation-aware runtime state.
The server audits mutations while keeping terminal output bounded and
encrypted.

The four optional client controls travel from the authorized operation through
the server's authenticated application live WebSocket. The server selects only
same-owner, project-active clients that declared the exact capability. Requests
expire within ten seconds, are acknowledged, and are neither persisted nor
placed in the replay ring. Client controls cannot create durable surfaces or
answer an interaction. Run configuration terminals instead materialize from
authorized server runtime state and are bound to the exact project, worktree,
configuration revision, and runtime generation. See [`MCP.md`](MCP.md) for the
full catalog and lifecycle.

## 2. Authentication modes

`CANTRIP_AUTH_MODE` has three deliberately separate meanings:

| Mode       | Principal                     | Intended deployment                       | Behavior                                                                |
| ---------- | ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `none`     | Stable anonymous owner        | Loopback development and embedded desktop | Every request receives the anonymous local principal.                   |
| `password` | Authenticated owner session   | Protected personal server                 | Argon2id credential creates a revocable server-side owner session.      |
| `accounts` | Authenticated account session | Public multi-user service                 | Email/password credentials create isolated, revocable account sessions. |

Account registration is license-gated by default. `CANTRIP_ADMIN_EMAIL`
identifies the bootstrap administrator, and the server-owned whitelist records
which additional normalized email addresses may register. Whitelist management
requires an authenticated owner or administrator and all mutations retain the
normal CSRF, origin, rate-limit, and audit protections. Operators may explicitly
set `CANTRIP_LICENSE_WHITELIST_ENABLED=false` to allow open registration.

`CANTRIP_ALLOW_INSECURE_REMOTE` applies only to a non-hosted anonymous server
and remains an acknowledgement for a separately protected trusted network. It
is not authentication and can never enable anonymous hosted mode.

Hosted configuration requires password or account authentication, PostgreSQL,
one explicit HTTPS public API origin, explicit approved application origins,
and a bounded trusted-proxy list containing only IP addresses, CIDRs, or named
private ranges. The current configuration parser also requires a hosted server
keyring, but provider and MCP envelopes do not use that keyring. The server
passes the proxy list to Fastify rather than trusting all proxies. Requests
reject unconfigured, malformed, oversized, or ambiguous forwarding headers,
require the configured HTTPS scheme and public host, and reject unapproved
browser origins before application handlers run.

Every API response carries a server-generated request ID, no-store policy,
strict content/type/frame/referrer/permissions headers, and HSTS in hosted mode.
JSON, binary upload, and WebSocket payload ceilings are independently bounded
and configurable. The global request timeout remains disabled so legitimate
agent and worker operations are not terminated by an arbitrary short deadline;
individual bounded control operations retain their own explicit timeouts.

The bootstrap contract now distinguishes `authenticated` from
`authentication-required`, permits no current user before sign-in, and reports
registration separately. Capability flags remain false until their full
behavior is implemented. Clients must not infer authentication from deployment
mode, hostname, or whether a server happens to return account-shaped data.

## 3. Request principal

`cantrip_server/src/auth/principal.ts` owns the request-scoped identity:

- `anonymous`: the loopback local owner, with no session credential;
- `account`: a password or account session resolved from a hashed server-side
  session token; or
- `unauthenticated`: no authorized owner and therefore no access to protected
  resources.

An authenticated principal carries the user summary, role, authentication
method, and optional session ID. Repository owner IDs must originate from this
principal. URL parameters, request bodies, project metadata, worker messages,
and live-event scopes must never select an owner.

The local server installs its anonymous principal through the same Fastify
request hook used by protected modes. Bootstrap, worker listing, health worker
counts, and the application live WebSocket consume the request principal. The
generated audit records direct `LOCAL_USER_ID` application routes as migration
debt and currently reports zero. Remaining uses of the local owner are limited
to anonymous bootstrap/default-state lifecycle paths and explicit local
fallbacks outside request-owned account operations.

## 3.1 Credential and session controls

- Passwords are encoded with Argon2id (64 MiB, three passes, one lane). The
  server never accepts a plaintext password through configuration.
- Browser sessions use 256-bit random opaque cookies. Only SHA-256 token hashes
  are stored in PostgreSQL/PGlite.
- Each session has an independent CSRF secret, expiry, last-seen metadata, and
  explicit revocation state. Sign-out can revoke one or all user sessions.
- Hosted cookies use the `__Host-` prefix, `HttpOnly`, `Secure`, `Path=/`, and a
  configurable SameSite policy. `SameSite=None` is rejected unless Secure is
  enabled.
- Cookie-authenticated mutations require the matching CSRF header. Login and
  registration additionally reject unapproved browser origins.
- Authentication attempts are rate limited by operation, client address, and
  normalized identity. Missing and incorrect accounts return the same error.
- Request logging redacts cookies, authorization, CSRF/bootstrap tokens,
  passwords, and response cookies.
- Public registration is independently configurable. With it disabled, the
  first owner requires a 32+ character bootstrap token; later registration is
  denied.

## 4. Complete boundary inventory

`scripts/audit-server-boundaries.mjs` parses the authoritative server and
protocol sources. The checked-in JSON records every Fastify route, including
the finite dynamically registered surface actions, every worker command type,
every application live resource, and every public asynchronous repository
entry point. CI-visible verification fails when a route is added or moved
without refreshing the inventory.

The generated inventory is the authoritative, revision-specific count of HTTP
and WebSocket routes, worker command variants, application live resources,
database repository entry points, and durable table classifications. Section 6
describes the current runtime data planes; the generator's legacy external
transport list is compatibility inventory rather than the complete WorkerLink
topology. Do not copy generated counts into another long-lived contract.

The same audit enforces the Task E2EE trust boundary. Production server source
cannot import `@cantrip/crypto`, Task decryption helpers, or trusted client and
worker Task adapters; Task routes must expose an audited opaque or
plaintext-rejection contract; and repositories must keep plaintext ordinary
messages, queued prompts, and project automations out of Task-experience
chats. The generated `taskE2eeBoundary` record makes these checks reviewable.

The inventory's `ownerEvidence` field is not an authorization guarantee. It is
a review ledger:

- `request-principal` means the route directly consumes its request identity;
- `explicit-owner` means a repository method requires an owner argument;
- `worker-scoped` means the caller must first bind the worker credential to its
  owner;
- `legacy-local-owner` is a blocker for hosted application routes;
- `worker-credential` identifies the independently authenticated machine
  boundary used by internal worker routes; and
- `delegated-or-missing-review` must be proven through its caller or changed to
  take an explicit owner.

The checked-in inventory drives legacy application routes to zero. Delegated
repository methods remain an explicit review ledger and are covered through
their authenticated caller or lifecycle-only contract.

## 5. HTTP and WebSocket boundaries

### Public bootstrap

Only service identification, authentication bootstrap, and the bounded
registration/login/session endpoints are public. Bootstrap
may disclose protocol/deployment/authentication capabilities, but no projects,
workers, provider configuration, account profile, or connection counts before
authentication. Health/readiness data must remain operational and aggregate;
it must not become an account-data side channel.

### Application API and live stream

All other application routes require an authenticated request principal. The
same principal is captured when `/api/live` upgrades and remains fixed for that
socket. Every requested live scope is authorized against the captured owner.
Session revocation must close its live sockets rather than allowing a stale
connection to retain access.

CORS and WebSocket Origin validation are browser defenses. Neither replaces a
principal. Native clients and raw HTTP clients are not constrained by CORS.

### Worker control

The generated `/api/internal/*` route entries form a distinct
machine-credential boundary. They cover worker presence, enrollment and command
attachment; worker encryption bootstrap; automation synchronization and
dispatch reporting; managed agent-operation and CLI dispatch; Code-settings
synchronization; and opaque provider-account credential fetch/reseal.

Hosted and standalone workers authenticate with a unique credential bound to
one owner and immutable worker ID. The server stores only its SHA-256 hash,
checks a route-specific scope, updates last-use time, and rejects a credential
presented for any other worker ID. Provider credential routes additionally
require an active `provider-credential` encryption grant and return or accept
only protected envelopes. Rotation or revocation closes the active worker
socket immediately. The shared worker token remains accepted only for
anonymous loopback `pnpm-dev` and embedded Tauri bootstraps. An authenticated
worker event may mutate only resources already leased or assigned to that same
owner and worker.

## 6. Runtime transport and data-plane boundaries

| Plane                         | Current binding                                                                                                                                                           | Required revocation boundary                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Application live hub          | Request owner plus authorized resource scope                                                                                                                              | Account session                                    |
| Worker control bridge         | Owner, worker ID, scope, and individual credential                                                                                                                        | Individual worker credential                       |
| WorkerLink session and grants | Server identity/generation, owner, account session, client instance, worker/process generation, optional attachment, exact resources, operations, lanes, count, and lease | App session, worker generation, session, or grant  |
| Cantrip Code tunnel           | Protected attachment carried by an exact WorkerLink grant and browser adapter/root lease or native loopback                                                               | Attachment, app session, worker, or editor session |
| Project-share/tunnel framing  | Application-encrypted root, credentials, and data key opened by the authorized worker and carried inside a WorkerLink reliable stream                                     | Attachment, app session, worker, or project        |

Code and project-share data do not use a second public server origin. Browser
Code is exposed only through an application-origin virtual adapter whose
browser-local root lease and exact iframe binding are checked before requests
enter the tunnel. Native Code and project-share clients use loopback forwards.
Protected route material and bearer capabilities must never be logged,
persisted in ordinary browser storage, or accepted for a different binding.

### Managed-folder authority

Managed-folder creation, setup retry, removal, and GitHub conversion are normal
application-principal routes in the generated inventory. The server derives the
owner from the authenticated request, verifies workspace membership and the
selected worker's owner/capability, and sends only the project UUID and bounded
intent through the authenticated worker channel. Clients never provide a
physical path.

The worker derives a workspace-specific directory beneath its managed folder
root, rejects malformed identifiers, symlinks, and paths outside the canonical
root, and deletes only that exact managed directory. Older installations may
retain UUID-derived paths beneath `<worker-data>/folders/`. The source remains
pinned to that worker for all
filesystem-backed surfaces; stale or malicious cross-worker targets fail before
dispatch. Git, GitHub, worktree, replica, relocation, and Git-event routes also
enforce the persisted project capability, so a local `git init` cannot expand
authority. Conversion enables those capabilities only after the worker binds
and pushes the selected new/empty GitHub repository and the server atomically
commits the reconciled source identity.

### GitHub repository placement authority

Custom GitHub placement is also worker-owned, but unlike a managed folder the
user may express one exact worker path. Before the project or replica mutation,
the app registers that raw value through an authenticated protected repository
operation on the selected worker. The server receives and persists only an
opaque routing handle plus the placement mode. It authorizes the account,
project, worker, replica, and durable job attempt but cannot parse or
dereference the path.

The worker resolves the handle, applies platform path rules, creates missing
parents without changing existing permissions, and canonicalizes the result.
Direct creation uses same-parent staging and two independent ownership proofs:
an owner-only worker registry and an untracked Git-common-directory marker.
Attaching an existing matching Primary writes no ownership marker and remains
user-owned. Managed links are verified conveniences; runtime commands always
receive the managed clone's canonical path.

Destructive removal never accepts a client-supplied path, placement mode, or
ownership claim. The server derives those facts from the active source and the
worker revalidates canonical Git identity, fingerprint, origin, placement
record, and—when applicable—the ownership marker. User-owned attachments are
never deleted. Retargeted links and created parent directories are left
untouched. Server logs, audits, progress, live events, and stored errors use
bounded stage/reason codes and must not include resolved raw paths.

New capabilities default false for rolling-version safety. The app, mutation
route, and job executor each gate direct/link requests against the selected
worker's advertisement; Windows link support is advertised only after a real
junction probe. Container mounts and service permissions remain deployment
authority, not something a client path can bypass. See
[PROJECT_REPOSITORY_PLACEMENT.md](PROJECT_REPOSITORY_PLACEMENT.md).

### Run environment authority

Codex-compatible setup and action scripts are arbitrary worker-side code.
Discovery, execution, authoring, terminal materialization, and setup retry all
retain the app → server → worker boundary. Public list/read responses omit raw
scripts; the worker reopens the source-root file and revision-checks the opaque
action immediately before spawning a managed PTY. The server persists only
bounded Run identity/lifecycle metadata, while scrollback and setup environment
deltas remain worker-local. Revision-checked authoring never changes Git state.

Path, race, process-tree, binding, response-limit, offline/restart, and client
surface threats are mapped to controls in
[the Run environment threat model](RUN_CONFIGURATIONS.md#threat-model).

## 7. Database ownership

Account-owned tables use an `owner_id` foreign key. Child resources must be
loaded through a query that joins or filters their owner instead of loading by
globally supplied ID and checking later. System state and lifecycle recovery
are the only intentionally global query families.

Migrations `0047_next_madripoor`, `0049_flippant_meggan`, and
`0051_sharp_newton_destine` establish the
protected-mode foundation:

- user role, status, normalized email, and password-change metadata;
- hashed, expiring, revocable user sessions;
- hashed, expiring, single-use worker enrollment codes; and
- independently hashed, scoped, rotatable, revocable worker credentials.

The worker-management migration also separates the runtime-reported machine
name from the owner's durable display alias and records non-destructive unlink
state. Unlinking revokes credentials and disconnects the socket but does not
cascade-delete project sources, worktrees, chats, or other server history.

The CSRF upgrade revokes any session created by an older server revision rather
than manufacturing a usable CSRF credential for it.

The migration stores no raw session token, enrollment code, or worker secret.
The enrollment service consumes link codes transactionally and returns a raw
credential exactly once; list APIs expose metadata but never hashes or raw
secrets.

Provider API keys, provider-account labels and OAuth bundles, and complete MCP
configurations use row-bound AES-256-GCM endpoint-encryption envelopes. The app
seals static API keys, account labels, and user-authored MCP configurations
before upload. Authorized workers open provider and MCP envelopes only for
runtime use, and workers encrypt discovered MCP configurations before relay.

The server stores and routes only protected envelopes plus the minimum
documented metadata. Provider API-key summaries expose `hasApiKey`. MCP rows
retain scope, enabled state, project/worker routing IDs, a keyed name blind
index, timestamps, and `protectedConfiguration`; the server sees neither MCP
names nor commands, URLs, headers, or environment values. Runtime dispatch
carries the opaque envelopes to an authorized worker.

`CANTRIP_SECRET_ENCRYPTION_KEYS` remains a hosted startup requirement in the
current configuration parser, but `ServerRepository` explicitly does not use
that `SecretVault` for provider or MCP payloads. It is not a provider/MCP
decryption, rotation, backup, or recovery key. A PostgreSQL or server-keyring
copy cannot open these records without an account component key held by an
unlocked application or approved worker.

### 7.1 Portable provider OAuth accounts

ChatGPT and Grok/SuperGrok access, refresh, ID, and upstream-identity values are
sealed on an authorized worker under the `provider-credential` component. The
envelope is authenticated to its owner, provider/account row, field, and key
revision. The server stores the protected bundle, keyed subject blind index,
optimistic credential revision, lifecycle state, and bounded expiry and coarse
quota metadata; it cannot exchange, refresh, or inspect the credential.

The internal credential GET and PUT routes authenticate the worker's individual
credential, derive its immutable owner and worker ID, and require an active
`provider-credential` grant. GET returns the opaque credential envelope and
revision, not an access token. The worker decrypts and validates provider
identity locally, contacts the provider when refresh is required, and reseals
the complete replacement before PUT. Expected revisions reject stale writes;
the subject blind index rejects an upstream identity change. The worker's usable
access lease remains memory-only for at most five minutes and never beyond
upstream expiry.

Global sign-out removes the durable envelope, advances its revision, updates
lifecycle state, and tells connected workers to close the affected runtime.
Because the server cannot decrypt the bundle, it cannot perform provider-side
revocation; operators must use the provider's security controls when upstream
revocation is required.

The server is therefore an opaque credential store and authorization relay,
not a trusted credential broker. A database dump or operator server keyring
alone does not reveal provider credentials. A compromised approved worker can
use the component keys granted to it, and an exfiltrated bearer token remains
usable until expiry or upstream revocation. Never copy OAuth capture payloads,
opened credentials, protected envelopes, or lease values into logs, events,
diagnostics, support bundles, or browser state. The full data flow and
verification procedure live in
[`PROVIDER_AUTHENTICATION.md`](PROVIDER_AUTHENTICATION.md).

The append-only `audit_events` ledger records authentication decisions, session
revocation, worker enrollment outcomes, project access, Git requests, and
provider/MCP/worker/project configuration mutations. Events carry the actor and
owner IDs, resource identity, result, request correlation ID, and hashes of the
client address and user agent. Metadata is deliberately bounded and allowlisted
by call sites; request bodies, credentials, email addresses, prompts, terminal
content, and source content are never copied into the ledger. Accounts can list
only their own events through `/api/account/audit-events`; owner/admin roles can
inspect the global stream through `/api/admin/audit-events`. Both APIs use
descending cursor pagination. `/api/account/sessions` similarly exposes active
session metadata without any stored token, CSRF, address, or user-agent hash.

Public API, worker-pairing, attachment-upload, and WebSocket-handshake traffic
use independent bounded sliding windows. Active uploads and application/tunnel
WebSockets are capped per account. Attachment bytes, Remote Surface sessions,
and relayed Code, browser, desktop, terminal, project-share, and generic tunnel
bytes are charged against both the account and worker. Every command routed to
a worker is bounded by per-worker and per-account byte, rate, and concurrency
ceilings; reaching a ceiling fails visibly instead of accumulating an unbounded
queue. These guards do not impose a short execution timeout, so an admitted
Codex turn or attached terminal may remain active for its normal lifetime.
Those two event streams are the only application routes that intentionally use
the streaming worker-command policy. Finite Git and GitHub control operations
have an explicit 30-minute deadline; all other finite worker requests retain a
bounded command deadline as well. Binary transports retain their schema payload
ceilings and buffered-byte backpressure rules. Each process enforces a
conservative partition of the configured global limits.
`CANTRIP_COORDINATION_MAX_INSTANCES` is the hard deployment ceiling and Redis
readiness fails when more live server leases exist. This preserves the global
bound without putting synchronous media frames behind a Redis round trip. It
can under-use capacity when fewer replicas are running, which is an intentional
availability-versus-abuse-resistance tradeoff.

`/healthz` proves only that the server process can answer HTTP. `/readyz` probes
the authoritative database and returns 503 while it is unavailable. `/metrics`
exposes aggregate Prometheus text to an owner/admin session or a dedicated
operator bearer token. Metrics include request counts and latency, database
probe health, worker and command activity, live connections, tunnel and relay
traffic, and quota rejections. Project-automation scheduling and dispatch are
observable through structured `automation.schedule-sync.*` and
`automation.dispatch.*` logs. These signals deliberately omit owner IDs,
resource IDs, URLs, prompts, terminal output, filenames, and secrets.

## 8. Application connection audit

All renderer connections derive from the selected server profile:

- `cantrip_app/src/lib/server-connections.ts` tests bootstrap and switches the
  active server origin;
- `cantrip_app/src/lib/api-client.ts` performs credentialed application HTTP;
- `cantrip_app/src/lib/app-live-client.ts` owns the resumable application WSS;
- `cantrip_app/src/components/terminal/terminal-view.tsx` attaches terminal
  streams through the shared WorkerLink;
- `cantrip_app/src/lib/remote-surface-worker-link.ts` carries protected Browser
  and Remote Desktop streams over the selected WorkerLink carrier; and
- Code and project-share attachments use server-authorized protected route
  bindings. Browser Code materializes an application-origin virtual adapter;
  native attachments materialize as loopback forwards.

Switching server profiles must discard server/account-scoped caches and live
connections. Passwords and raw session credentials must never be placed in a
server profile or `localStorage`.

## 9. Invariants for subsequent milestones

1. Local `none` mode stays zero-auth and loopback-only by default.
2. Protected modes do not start until their route and transport boundaries are
   enforced.
3. Every application-owned database operation derives `ownerId` from the
   request principal or a durable server-owned lease created by that principal.
4. Every worker operation derives owner and worker identity from its individual
   credential, not its payload.
5. Cross-worker handoff requires an explicit compatible project source; equal
   project IDs never imply equal files.
6. Revoking an app session, worker credential, or capability terminates its
   active sockets and attachments.
7. Logs and metrics contain correlation IDs, never credentials, prompts,
   terminal contents, or source contents by default.
8. Multi-instance routing moves only bounded, expiring envelopes carrying
   correlation IDs. The receiving instance revalidates worker ownership and
   protocol payloads before reaching a local worker socket.

## 10. Shared relay coordination

`REDIS_URL` enables the production coordination path. Every process receives a
unique instance ID (or an operator-provided stable ID), writes a TTL-backed
instance lease, and claims each locally connected worker with a connection-ID
fenced presence lease. The newest Redis claim wins. An older connection closes
when it receives the replacement notice or when its compare-and-refresh fails;
stale owners disappear automatically after the configured presence TTL.

Commands sent to a worker owned by another process use an instance-targeted,
expiring envelope. Request, event, response, notification, disconnect, and
binary frame messages are schema-checked or protocol-checked at receipt.
Pending and incoming command counts plus asynchronous publication counts are
bounded. Worker/account identity is derived from PostgreSQL and the presence
lease rather than trusted from a client payload. Code, Remote Surface, project
share, and generic tunnel frames use the same bridge, so sticky routing improves
bandwidth locality but is not required for correctness.

Application live invalidations are broadcast to every server and filtered by
the destination hub's authenticated owner and authorized subscriptions.
Per-instance epochs and authoritative HTTP snapshots remain the reconnect
contract; Redis pub/sub is an invalidation transport, not durable history.
PostgreSQL remains authoritative for conversations and configuration.

## 11. Project-automation scheduler fencing

Chat-targeted project automations claim each calendar occurrence in PostgreSQL
before dispatch. The owning worker polls its authorized schedule list and
requests due occurrences. Claims persist the scheduled time, target ownership,
serving instance, opaque lease token, expiration, and a monotonically increasing
fencing token. An unexpired claim rejects duplicate dispatch. After
`CANTRIP_SCHEDULER_LEASE_TTL_MS`, another server may recover the same occurrence
with a higher fence; the former holder can no longer finalize it.

Dispatch uses `automation:<automationId>:<scheduledFor>` as its idempotency key
and checks both queued prompts and persisted chat messages before adding work,
so a crash after durable acceptance does not add the prompt twice. A moved
chat/source fails closed because the server revalidates the worker from the
chat's active worktree. If that chat has automation paused, the protected prompt
is queued rather than started. If the owning worker is offline, the due
occurrence remains pending until that worker resumes polling; recovery runs at
most one missed occurrence before advancing to the next future slot. Legacy
workflow trigger/delivery/run rows are not scheduled, executed, or recovered by
current code.
