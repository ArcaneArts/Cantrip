# Policies

Status: implemented. This document describes the current encrypted Policy
contract.

Cantrip Policies are reusable, owner-scoped instruction documents. Users create
and edit them in root Settings, order them globally, and choose where they
apply. Policy semantic content is end-to-end encrypted: the server schedules
and routes Policies without reading their keys, names, summaries, or Markdown
bodies.

For the cryptographic construction and migration history, see
[ENCRYPTION.md](ENCRYPTION.md#policies-and-effective-agent-instructions).

## Product model

Each Policy has:

- a stable lowercase key used by `policy_read` and
  `cantrip policy read <key>`;
- a display name;
- a compact summary;
- a full Markdown body;
- an audience: `ide`, `chat`, or `both`;
- Enabled and Mandatory controls;
- one account-wide sort position;
- optional packaged-template provenance; and
- optimistic row and collection versions.

The audience controls which runtime receives the Policy:

| Audience | Project-backed Agent, Plan, Goal, and Task turns | Standalone Chat |
| -------- | ------------------------------------------------ | --------------- |
| `ide`    | Yes                                              | No              |
| `chat`   | No                                               | Yes             |
| `both`   | Yes                                              | Yes             |

“Global” means available across the owner's projects and workspaces on one
Cantrip server. It does not mean an operator can silently impose a Policy on
unrelated tenants. Mandatory is also owner-controlled rather than an
administrator lock.

## Effectiveness and ordering

For a project-backed turn, an `ide` or `both` Policy is effective when:

```text
enabled AND (mandatory OR assigned to the project OR assigned to the project's workspace)
```

Every project belongs to exactly one workspace. If a Policy reaches the project
through more than one source, the effective list contains it once and reports
all sources. Disabling a Policy suppresses it without deleting assignments.
Removing Mandatory leaves explicit workspace and project assignments intact.

For a standalone Chat, every enabled `chat` or `both` Policy is effective.
Standalone Chat has no project or workspace assignment scope.

Effective Policies retain the owner's configured order: lower position first,
with stable row identity as the deterministic tie-breaker. Cantrip does not
interpret prose, merge requirements, or invent precedence between Policies.

## Encrypted content and server-visible metadata

Policy content uses the `policy-content` encryption component. The unlocked
client allocates the Policy ID, computes a keyed blind index for its semantic
key, and seals two independently bounded envelopes:

- `protectedSummary`: key, name, and summary;
- `protectedBody`: full Markdown body.

The envelopes are bound to the owner, Policy ID, field, format version, and key
revision. The server stores only:

- Policy ID and key blind index;
- the two opaque envelopes;
- audience, Enabled, Mandatory, order, and template provenance;
- workspace/project assignment rows;
- row and collection versions; and
- timestamps and assignment counts.

The server can enforce owner isolation, key uniqueness, assignment scope,
audience filtering, ordering, limits, and optimistic concurrency without
receiving semantic content. It never decrypts a Policy or constructs Policy
prompt text. There is no plaintext compatibility fallback.

Routine logs and telemetry may identify an operation and opaque Policy ID, but
must not contain decrypted keys, names, summaries, bodies, or envelope
ciphertext.

## Creation, editing, and templates

Root **Settings → Policy** is the authoring surface. It supports:

- creating a blank Policy;
- copying a packaged template;
- editing name, summary, body, audience, Enabled, and Mandatory;
- reordering Policies;
- resetting a template-derived Policy after confirmation; and
- permanently deleting a Policy after confirmation.

The repository-root `policy_templates/` directory contains immutable public
starter documents. Templates never apply by themselves. Copying or resetting a
template happens in an unlocked client, and the resulting Policy content is
encrypted before it leaves that client. The packaged Manual Change Protocol is
opt-in. Updating a packaged template never overwrites an existing user Policy.

Account bootstrap is encrypted, transactional, and idempotent. An unlocked
client creates every packaged template flagged `suggestedDefault`, using
client-allocated IDs and protected content. The current catalog has no
suggested defaults, so bootstrap records version 2 without creating a Policy.
Deleting a bootstrapped Policy does not cause the server to recreate it.

## Assignment experience

Workspace Settings manages Policies inherited by that workspace. Project
Settings manages direct project assignments and shows inherited and Mandatory
sources separately. Assignment mutations send the complete desired set plus
the current collection version; stale writes return a conflict rather than
silently overwriting another client.

The Settings app decrypts summaries and bodies locally. A locked client cannot
open or modify semantic Policy content, but the server may still retain and
route the opaque rows.

## HTTP and wire contracts

The owner-authorized HTTP surface is:

```text
GET    /api/policy-templates
GET    /api/policy-templates/:templateKey
GET    /api/policies
POST   /api/policies/bootstrap
POST   /api/policies
PATCH  /api/policies/order
GET    /api/policies/:policyId
PATCH  /api/policies/:policyId
DELETE /api/policies/:policyId
GET    /api/workspaces/:workspaceId/policies
PATCH  /api/workspaces/:workspaceId/policies
GET    /api/projects/:projectId/policies
PATCH  /api/projects/:projectId/policies
GET    /api/projects/:projectId/effective-policies
```

Template responses are public packaged content. Policy list/detail and
assignment responses use wire schemas containing opaque protected summaries or
bodies. Effective-project responses contain protected summaries plus public
Mandatory/workspace/project source identifiers. The app decrypts these for
display.

Mutation schemas are strict and bounded. Individual edits, resets, and deletes
use `rowVersion`; create/delete/order/assignment changes advance a
`collectionVersion`. Policy mutations publish the owner-scoped `policy` live
resource so clients refetch only authorized state.

Current limits are:

- 500 Policies per owner;
- 64 effective Policies per runtime context;
- 80 characters per key;
- 120 characters per name;
- 1,000 characters per summary;
- 100,000 characters per Markdown body; and
- 32 KiB of assembled runtime Policy context.

If effective content exceeds a bound, the runtime fails with an actionable
error. It never drops an arbitrary tail.

## Runtime delivery

### Project-backed Agent and Task turns

The server resolves only Enabled, audience, Mandatory, assignment, and ordering
metadata, then sends the selected protected summaries to the authorized worker.
The worker decrypts them and constructs one compact application-owned context
block:

```text
Effective Cantrip policies apply to this project.

[manual-change-protocol] Manual Change Protocol
Every manually requested repository change follows the documented PR flow.
```

The worker regenerates this summary context for each new turn. Retries within
one already-started turn retain that turn's snapshot. Policy bodies are not
automatically injected into project-backed turns; a summary may tell the Agent
to read the current body when needed.

### Standalone Chat

Standalone Chat does not receive the managed Cantrip Policy tools. The server
therefore selects all enabled `chat` or `both` Policies and sends their opaque
summary and body envelopes to the authorized worker. The worker decrypts and
injects the full ordered bodies directly into the Chat context. Semantic
content never becomes server-readable during this flow.

## Managed MCP and CLI

Project-backed Codex sessions prefer the read-only managed operations:

```text
policy_list
policy_read
```

The CLI fallback is:

```text
cantrip policy list
cantrip policy read <policy-key>
```

`policy_list` returns the effective key, name, summary, Mandatory flag, and
source labels in configured order. `policy_read` returns the current full body
only for an effective Policy in the resolved project.

Selection remains semantically blind on the server. The server sends bounded
opaque candidates for the authorized project; the worker decrypts them,
resolves the requested semantic key, and renders the result locally. The CLI
uses the authenticated worker-local broker and exposes the same stable JSON
contract. Neither MCP nor CLI exposes Policy mutation.

## Failure and lifecycle behavior

- A stale row, reorder, or assignment mutation returns a revision conflict.
- Deleting a Policy cascades its assignments and affects the next turn; it does
  not interrupt an already-running turn.
- Removing a workspace or project deletes only its assignment rows.
- A locked, missing, stale, revoked, wrong-owner, or tampered encryption grant
  fails closed.
- Worker unavailability blocks worker-side decryption and runtime use but does
  not make the server inspect protected content.
- Markdown is rendered through the existing sanitized renderer.
- Repository files cannot create, mutate, or assign account Policies.

## Verification anchors

The current implementation is defined by:

- `packages/protocol/src/policies.ts` for bounded public, wire, and encrypted
  schemas;
- `packages/crypto/src/policy-content.ts` for envelope construction;
- `cantrip_app/src/lib/policy-encryption.ts` for client sealing/opening;
- `cantrip_server/src/db/policies.ts` and
  `cantrip_server/src/app/routes/policies.ts` for semantically blind storage,
  scope resolution, and routing; and
- `cantrip_worker/src/policy-encryption.ts` for worker decryption, context
  assembly, and CLI/MCP rendering.

Tests cover encrypted bootstrap and CRUD, blind-index uniqueness, audience
filtering, assignment resolution, optimistic concurrency, worker-only context
assembly, standalone full-body injection, CLI/MCP reads, tampering, bounds, and
owner isolation.

## Explicit non-goals

- operator Policies spanning unrelated tenants;
- server-side semantic search, parsing, conflict resolution, or prompt
  composition;
- repository-owned Policy definitions;
- Policy mutation from an Agent or the CLI;
- immutable Policy revision history; and
- hard enforcement of prose beyond providing it to the model.
