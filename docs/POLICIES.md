# Policies

## Purpose

Cantrip Policies are server-owned, user-configured instruction documents that
apply to Agent work in selected projects. A policy is conceptually an expandable
system prompt:

- its short summary is made visible to every Agent working in an affected
  project;
- its full Markdown body remains on the server;
- an Agent can read the current full body with the Cantrip CLI when the summary
  says it is relevant;
- users create and edit policies only from root Settings;
- users assign nonmandatory policies to workspaces or projects;
- a mandatory policy applies to every project owned by that user on the server.

Policies provide reusable operational expectations without copying instruction
files into every repository. The initial packaged policy is the Manual Change
Protocol. Cantrip creates one editable policy from that template during account
bootstrap and marks it mandatory by default. This is a convenience default from
the user to their projects, not an administrator rule imposed by Cantrip. The
user may edit, disable, unmark, reorder, or delete it.

This document defines the first complete Policy implementation. It intentionally
does not implement Task tabs; Tasks are designed separately in
[TASKS.md](TASKS.md) and assume this Policy system is already available.

## Product language

| Term                     | Meaning                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **Policy template**      | An immutable starting document packaged with Cantrip Server. Templates do not apply to projects by themselves. |
| **Policy**               | A mutable server-owned instruction document created by the user or instantiated from a template.               |
| **Mandatory**            | The user has chosen for the policy to apply to all of their projects across all workspaces.                    |
| **Workspace assignment** | The policy applies to every project visible in that workspace.                                                 |
| **Project assignment**   | The policy applies directly to one project.                                                                    |
| **Effective policy**     | An enabled policy that is mandatory or reaches a project through a workspace/project assignment.               |
| **Summary**              | Compact instruction text included in Agent context.                                                            |
| **Body**                 | Full Markdown instructions returned by cantrip policy read.                                                    |
| **Policy key**           | Stable user-visible identifier such as manual-change-protocol.                                                 |

“Global” in this feature means stored on Cantrip Server and available across all
of the user's projects and workspaces on that server. It does not mean a
deployment administrator can silently impose a policy on every tenant. Policies
remain owner-scoped under Cantrip's existing hosted authorization model.

## Core behavior

### Effectiveness

A policy is effective for a project when:

    policy.enabled
    AND (
      policy.mandatory
      OR policy is assigned directly to the project
      OR policy is assigned to any workspace containing the project
    )

Consequences:

- mandatory policies require no assignment rows;
- project membership in multiple workspaces produces the union of their
  policies;
- the same policy appears once even if it reaches the project through several
  paths;
- disabling a policy suppresses it everywhere without discarding assignments;
- unmarking Mandatory immediately removes its global reach, but any explicit
  workspace/project assignments continue to apply;
- removing a project from a workspace removes policies inherited only through
  that workspace;
- direct project assignments remain effective regardless of workspace changes;
- deleting a policy removes all of its assignments;
- deleting a workspace or project removes only its assignment rows.

Mandatory is controlled by the user. The UI must not describe it as a locked
Cantrip requirement.

### Ordering

Policies are sortable in root Settings. Effective summaries are presented to
Agents in that user-defined order:

1. lower position first;
2. stable key as the deterministic tie-breaker.

Ordering is simply display/injection order. Cantrip does not interpret policy
prose, merge requirements, or implement a separate conflict/precedence system.
The policies are supplied to the Agent as user-configured instructions in the
chosen order.

### Updates

Policy reads always return the current stored document:

- a user edit affects future Agent turns;
- an Agent running cantrip policy read after the edit sees the new body;
- no policy revision number needs to be shown or injected;
- Cantrip does not notify an Agent that a policy changed;
- an already-running turn is not interrupted;
- Task Goals do not freeze policy content.

The database still uses ordinary optimistic row versions/updated timestamps to
prevent two Settings windows from silently overwriting each other. That
concurrency mechanism is not part of the Agent-facing policy model.

## Packaged templates and bootstrap

### Template catalog

Cantrip Server packages a small catalog of immutable policy templates. Each
template contains:

- template key;
- display name;
- suggested policy key;
- short summary;
- Markdown body;
- packaged template version;
- optional suggested enabled/mandatory defaults.

Templates are code/distribution assets, not database policies. Editing or
deleting a policy instantiated from a template does not modify the template.

The **+ Policy** flow offers:

- Blank policy;
- Manual Change Protocol;
- any future packaged templates.

Selecting a template copies its current contents into a new independent policy.
If the suggested key is already used, the UI requires another unique key or
proposes a suffix.

### Manual Change Protocol default

During one-time policy bootstrap for each user, Cantrip creates:

- name: Manual Change Protocol;
- key: manual-change-protocol;
- enabled: true;
- mandatory: true;
- summary and body copied from the packaged Manual Change Protocol template.

Existing users receive the same one-time bootstrap when the feature migration is
introduced. A durable bootstrap marker prevents the policy from being recreated
after the user deletes it. Users can always create a fresh copy later through
**+ Policy → Manual Change Protocol**.

The packaged template should be based on
docs/agents/MANUAL_CHANGE_PROTOCOL.md at build time, but the runtime policy is a
server database record after bootstrap. Updating the packaged template in a
future Cantrip release must not overwrite an existing user policy.

### Template operations

Policies created from templates may be edited and permanently deleted exactly
like blank policies. The editor may offer **Reset from template**, which replaces
the editable fields only after explicit confirmation. Resetting does not change
Enabled, Mandatory, assignments, or sort position unless the user explicitly
chooses to restore those defaults too.

## Data model

### policies

One owner-scoped row per editable policy:

| Field                 | Notes                                                        |
| --------------------- | ------------------------------------------------------------ |
| id                    | Internal UUID primary key.                                   |
| ownerId               | Required user/tenant owner.                                  |
| key                   | Stable lowercase key unique per owner; intended for CLI use. |
| name                  | Human-readable display name.                                 |
| summary               | Compact Agent-visible instruction summary.                   |
| bodyMarkdown          | Full Markdown body.                                          |
| enabled               | Whether the policy can be effective.                         |
| mandatory             | Whether it applies to all owner projects.                    |
| position              | User-controlled global order.                                |
| templateKey           | Nullable packaged-template provenance.                       |
| rowVersion            | Positive optimistic-concurrency counter.                     |
| createdAt / updatedAt | Server timestamps.                                           |

Suggested validation:

- name: 1–120 trimmed characters;
- key: 1–80 lowercase letters, digits, and single dashes, beginning and ending
  with a letter/digit;
- summary: 1–1,000 characters;
- body Markdown: 1–100,000 characters;
- at most 500 policies per owner;
- uniqueness on ownerId + key;
- position nonnegative;
- rowVersion positive.

The key remains stable during normal editing. A dedicated key-change operation
may be added later; the initial UI should make the key immutable after creation
to keep instructions and scripts reliable.

### project_policy_assignments

| Field     | Notes                             |
| --------- | --------------------------------- |
| policyId  | Owner-scoped policy foreign key.  |
| projectId | Owner-scoped project foreign key. |
| createdAt | Server timestamp.                 |

Primary key: policyId + projectId.

### workspace_policy_assignments

| Field       | Notes                               |
| ----------- | ----------------------------------- |
| policyId    | Owner-scoped policy foreign key.    |
| workspaceId | Owner-scoped workspace foreign key. |
| createdAt   | Server timestamp.                   |

Primary key: policyId + workspaceId.

Every assignment mutation verifies that both sides belong to the authenticated
owner. Cross-tenant IDs return not found/forbidden under the existing server
convention and never reveal record existence.

### user policy bootstrap

Store a policy bootstrap version in user settings or a dedicated bootstrap
record. Bootstrap must be transactional and idempotent:

- version absent: instantiate the current required defaults once;
- version current: do nothing;
- policy deleted after bootstrap: do not recreate it;
- concurrent first requests: create at most one default policy.

## Protocol contracts

Introduce bounded schemas for:

- PolicyTemplateSummary
- PolicySummary
- PolicyDetail
- PolicyCreate
- PolicyUpdate
- PolicyOrderUpdate
- PolicyAssignmentUpdate
- EffectivePolicySummary
- EffectivePolicyList

PolicySummary should include assignment counts for Settings but not the full
body. PolicyDetail includes the body. EffectivePolicySummary includes only:

- key;
- name;
- summary;
- mandatory;
- effective source labels needed by the UI.

No API should include every policy body in ordinary list/bootstrap responses.

## Server API

Suggested owner-authorized routes:

### Templates

    GET /api/policy-templates
    GET /api/policy-templates/:templateKey

### Root policies

    GET    /api/policies
    POST   /api/policies
    GET    /api/policies/:policyId
    PATCH  /api/policies/:policyId
    DELETE /api/policies/:policyId
    PATCH  /api/policies/order
    POST   /api/policies/from-template/:templateKey
    POST   /api/policies/:policyId/reset-template

### Assignments and effective state

    GET   /api/projects/:projectId/policies
    PATCH /api/projects/:projectId/policies
    GET   /api/workspaces/:workspaceId/policies
    PATCH /api/workspaces/:workspaceId/policies
    GET   /api/projects/:projectId/effective-policies

Assignment updates carry the current collection/version token and the complete
desired set of direct assignments. Mandatory and inherited policies are returned
separately so clients cannot accidentally attempt to unassign them.

Policy mutations publish live invalidations for:

- root policy lists/details;
- affected project effective-policy queries;
- affected workspace assignment queries.

The invalidation implementation may publish an owner-wide policy change rather
than enumerating every affected project, provided clients still refetch only
authorized state.

## Settings experience

### Root Settings → Policies

Policies are created only here. Add a **Policies** tab to root Settings with the
same flat/divider-based visual language as other Settings pages.

Header:

- search;
- policy count;
- **+ Policy**.

Rows show:

- drag handle;
- name;
- stable key;
- summary;
- Enabled;
- Mandatory;
- workspace/project assignment counts;
- template/custom provenance;
- edit and delete actions.

Sorting writes the complete ordered ID list using an optimistic collection
version. Mandatory affects scope, not sort behavior.

### Create flow

**+ Policy** opens a template chooser:

- Blank;
- Manual Change Protocol;
- future packaged templates.

After choosing a template, open the normal policy editor with copied values.
Nothing is persisted until Save.

### Editor

Use a full-height dialog or settings subpage containing:

- name;
- immutable key after creation;
- short summary and character/context-budget indicator;
- Markdown body edit/preview;
- Enabled switch;
- Mandatory switch;
- assignment section;
- Save changes.

The assignment section permits selecting workspaces and projects. When
Mandatory is enabled, assignments remain stored but are visually secondary
because the policy already reaches every project.

Deleting a policy requires confirmation describing how many explicit
workspace/project assignments will be removed. Template provenance never blocks
deletion.

### Workspace assignment

Workspace Settings gains a Policies area/tab listing root-created policies:

- effective mandatory policies: checked and locked;
- policies directly assigned to the workspace: checked and removable;
- available policies: unchecked;
- disabled policies: visible but disabled with explanation.

Users cannot create/edit policy content from Workspace Settings; links open the
root policy editor.

### Project assignment

Project Settings gains a Policies tab:

- mandatory policies: effective, locked;
- workspace-inherited policies: effective, with source workspace names;
- directly assigned policies: effective and removable;
- available policies: assignable;
- disabled policies: visible but inactive.

If a policy is both directly assigned and inherited, show all sources but one
effective row. Removing the direct assignment must not imply that an inherited
policy stopped applying.

## Agent context

### Summary injection

Before every ordinary Agent, Plan, Goal, Task-planning, queued, or automatic
continuation turn, the server resolves the project's effective policies and
passes bounded summaries to the selected worker. The worker adds one
application-owned context value alongside the existing Cantrip worktree-policy
context.

Representative content:

    Effective Cantrip policies apply to this project.

    [manual-change-protocol] Manual Change Protocol
    Every manually requested repository change uses an isolated worktree,
    ready pull request, squash auto-merge, merge observation, and cleanup.
    Read the full policy before changing repository files or Git state:
    cantrip policy read manual-change-protocol

The context must:

- preserve configured policy order;
- include each policy once;
- omit disabled and ineffective policies;
- identify the exact policy key used by the CLI;
- avoid bodies, timestamps, revision numbers, assignment internals, and IDs;
- be regenerated for every turn so it reflects current server state.

### Bounds

Suggested first implementation bounds:

- at most 64 effective policy summaries;
- at most 32 KiB total encoded summary context;
- at most 1,000 characters per summary.

The Settings UI should make these limits difficult to exceed. If the effective
set cannot fit, the server must not silently drop an arbitrary tail. Reject the
turn with an actionable error naming the project and instruct the user to reduce
or consolidate policies.

### Full reads

The global Cantrip developer instruction tells Agents that policy summaries are
instructions and that cantrip policy read returns the current full policy.
Policies themselves decide when a full read is necessary. For example, the
Manual Change Protocol summary explicitly requires a full read before mutation.

The server does not automatically inject all policy bodies. This keeps normal
turn context compact and lets future policies contain lengthy checklists.

## Cantrip CLI

Add a Policy command group:

    cantrip policy list
    cantrip policy read <policy-key>

Both support the existing global --json flag.

### policy list

Returns the current project's effective policies in configured order:

- key;
- name;
- summary;
- mandatory flag;
- effective source labels.

It does not return bodies.

### policy read

Returns:

- key;
- name;
- summary;
- full current Markdown body.

The command resolves context through the existing thread ID, terminal ID, or
working-directory rules. It may read only an effective policy for the resolved
project. An unavailable or non-effective key returns a bounded not-found result
without revealing policies from another project/owner.

Policy CLI operations are read-only and server-owned:

- Rust CLI parses the command;
- the worker loopback broker supplies authenticated Cantrip context;
- Cantrip Server resolves the owner/project and returns the policy;
- no worker filesystem command is needed;
- output uses the existing stable JSON/result envelope.

## Security, privacy, and logging

- Policy rows and assignments are owner-scoped.
- Policy bodies are user-authored sensitive configuration and are not written to
  routine service logs, telemetry, or error metadata.
- Logs may include policy ID/key and operation outcome for audit purposes, but
  not summary/body text.
- Policy list/read operations are bounded.
- Markdown rendering uses the existing sanitized renderer.
- Template assets are trusted packaged data; copied policy bodies remain
  user-editable.
- Repository files cannot create or assign server policies.
- Agents receive no mutation-capable policy CLI commands.
- Effective-policy resolution must not depend on worker availability.

## Failure and concurrency behavior

- stale policy edits return conflict and preserve both user inputs;
- stale reorder operations refetch before retry;
- deleting a policy during an Agent turn does not interrupt the turn;
- the next turn omits the deleted policy;
- disabling a mandatory policy removes it from future effective sets;
- a missing template never invalidates policies already copied from it;
- malformed packaged templates fail server startup/build validation rather than
  creating corrupt policy records;
- workspace membership changes invalidate effective-policy queries;
- a disconnected worker does not prevent policy editing or assignment.

## Implementation sequence

Policies are implemented before Tasks. Each milestone follows
docs/agents/MANUAL_CHANGE_PROTOCOL.md in its own worktree/branch/PR and is
observed merged before the dependent milestone starts.

### Milestone 1: Domain, templates, and persistence

- protocol schemas;
- policies and assignment tables/migration;
- owner-scoped repository methods;
- effective-policy resolver;
- packaged template loader/validation;
- one-time Manual Change Protocol bootstrap;
- optimistic concurrency;
- protocol/server unit tests.

### Milestone 2: API and root Settings

- template and policy CRUD routes;
- order mutation;
- root Policies tab;
- template chooser;
- Markdown editor/preview;
- enabled/mandatory/delete/reset behavior;
- focused server/app tests.

### Milestone 3: Workspace and project assignments

- assignment endpoints;
- effective-source calculation;
- Workspace Settings Policies controls;
- Project Settings Policies tab;
- multiple-workspace deduplication;
- membership invalidation;
- authorization and UI tests.

### Milestone 4: CLI and Agent context

- protocol CLI command names/results;
- Rust Policy subcommands/help/output;
- server command handling;
- effective summary injection on every Agent turn type;
- current-value policy reads;
- context-bound errors;
- protocol/CLI/server/worker tests.

### Milestone 5: Hardening and documentation

- hosted tenant-isolation tests;
- prompt-budget/error tests;
- live invalidation/multi-window tests;
- accessibility/mobile Settings validation;
- logging/redaction review;
- README and FULL_DESCRIPTION updates;
- repository-wide validation.

## Acceptance criteria

- A fresh/existing user receives one editable Manual Change Protocol policy
  exactly once, enabled and mandatory.
- Deleting that policy does not cause it to reappear; the packaged template
  remains selectable.
- Users can create blank or template-based policies only from root Settings.
- Users can edit, enable/disable, mark/unmark Mandatory, sort, and delete any
  policy.
- Nonmandatory policies can be assigned to workspaces and projects.
- Effective policy resolution correctly unions mandatory, workspace, and direct
  project sources without duplicates.
- Every Agent turn receives current bounded summaries in user order.
- Agents can list/read only effective policies with the Cantrip CLI.
- Full bodies are not included in routine bootstrap/list responses or logs.
- Policy edits are visible on the next Agent turn/read without revision
  messaging.
- Policy ordering does not claim semantic override behavior.
- All mutations enforce owner isolation and optimistic concurrency.

## Explicit non-goals

- server-administrator policies spanning unrelated tenants;
- semantic policy parsing, conflict resolution, or override precedence;
- injecting every full body into every turn;
- immutable policy-history/audit UI;
- policy mutation from the CLI or Agent;
- repository-owned policy definitions;
- hard enforcement of prose instructions;
- Task tabs in the Policy implementation series.
