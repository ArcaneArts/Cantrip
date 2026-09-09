# Shared permission transitions

GUI and native terminal selections use the same durable native command admission.
For an existing native thread, the GUI sends its existing settings binding,
operation identity, and expected permission revision to the permission endpoint.
The worker resolves a terminal choice against the same canonical source. A missing
binding requires an actual native settings read; an existing valid binding does
not cause an extra read or readiness probe.

The public transition descriptor records the nullable selected preference, its
resolved selection, the effective profile after placement policy, and the prior
applied revision. Exact native settings remain encrypted. In particular,
`selectedId: null` follows the default when the choice is resolved; it does not
retrospectively relabel a confirmed native policy whenever the account default
changes. Primary placements with `required-for-writes` retain the requested
selection while enforcing the read-only effective profile.

Admission and dispatch both check the actual chat, placement, account, source,
policy, and expected revision under the chat lock. A competing unresolved
permission change receives `permission-transition-pending`; the caller can retry
after it settles. This is an explicit conflict, not a dropped choice.

A successful native RPC means queued. Desired and pending selections are retained
in the existing native settings journal; they do not change the confirmed chat
permission or active computer-use authority. The native permission request applies
at the root/descendant quiescent boundary. Application requires correlated native
operation/submission evidence. The worker compares the actual native security
settings with the admitted target before publishing the public profile claim.
The server stores that claim alongside the encrypted evidence and updates the
confirmed policy and chat preference atomically. Native rejection retains the
previous policy. Conflicting or incomplete application evidence remains uncertain.

The applied policy retains its exact native thread, account, placement, generation,
and settings version. Late evidence cannot change another source or a newer
policy. Duplicate evidence does not reapply a transition. Ordinary settings
observations are not permission-application receipts.

A same-thread cold resume retains the durable resolved selection as preparation
input. It is separately marked unconfirmed for the current runtime until current
native evidence verifies restoration. It must not fall back to a newly changed
account default. Current runtime confirmation and durable selected policy are
separate facts.

Before any native execution exists, an id-only GUI selection configures bootstrap
preference. The repository rechecks that no execution has started while holding
the same chat lock; a concurrent first turn requires the bound transition path.

Cold-resume recovery uses an actual native operation-journal read and a current
settings read, without replaying the permission mutation. Applied recovery evidence
keeps its original command/submission identity and names the current published
`recoveryBindingId`. The server validates the same durable thread, account and
placement, and updates current source proof without incrementing the logical
permission revision for the same selection. Old operations cannot replace a newer
confirmed policy. Exact security comparisons remain inside the worker; only the
correlated policy claim and source metadata are public.

If native `turn/start` returns the exact `pendingSettings` no-input rejection,
its failed attempt is settled as deferred. A queued follow-up keeps its prompt ID,
revision and protected content; it receives a new claim only after the pending
permission transition settles. A first GUI submission is retained through the
same encrypted queue codec, with its original message ID and ciphertext unchanged
and the exact unconsumed native vector separately protected. Attachment projection
is not repeated for an unchanged vector. Editing the queued text or attachment
selection rebuilds the user input and projects only the current attachments.

Native policy publication is acknowledged durably before the worker updates its
local policy and wakes retained input. Deferred settlement also returns queue
readiness from the persisted transition state, covering publication that arrived
before the deferral acknowledgment. Ordinary native rejections are not treated as
safe-to-retry deferrals.

Direct terminal input uses the same codec with its actual native client message ID
and literal `turn/start` classification. A permission deferral cannot reinterpret
slash-looking input as a new command. The gateway reports `queueRetained: true`
only after canonical settlement is acknowledged. A pre-write capture failure
preserves the draft; an uncertain acknowledgment preserves a nonsendable native
backup. Only positive matching canonical queue evidence clears that backup. An
empty queue is not proof that input was never retained or executed.

Exact encrypted deferred receipts are durably captured before HTTP delivery and
retried with their original operation identity. Recovery retries only receipt
settlement, never the native input operation. An immutable acknowledgment records
confirmed canonical ownership. Retired attempts can transfer input to the queue
only with captured no-consumption evidence and no conflicting result or observed
native turn. Newer execution lanes and stopped autonomy remain untouched. The
packaged-runtime fixture and retirement/restart regressions validate these paths.
