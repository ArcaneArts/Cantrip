//! Delivery and held-input lifetime, independent of transport and agent turns.
use crate::{
    input::InputEvent,
    ownership::{Ownership, OwnershipError, Participant, TargetIdentity},
};
use std::collections::BTreeMap;

/// Prepared resources must not have produced input. A Down always includes its
/// matching release, allocated before delivery can begin.
pub enum Prepared<C, P> {
    Down { control: C, packet: P, release: P },
    Up { control: C, packet: Option<P> },
    Repeat { control: C, packet: P },
    MoveHeld { control: C, packet: P, release: P },
    Action { controls: Vec<C>, packet: P },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// The backend dispatched input; the application response is not verified.
    DispatchedUnverified,
}
#[derive(Debug)]
pub enum PostFailure<E> {
    NotDispatched(E),
    Uncertain(E),
    BackendPanicked,
}

/// Concrete backends translate typed events into prepared resources. `prepare`
/// allocates/validates only; all external effects belong in `post`. Held entries
/// are exclusively those of the caller. Collision keys must canonicalize aliases
/// and represent shared backend state (e.g. a process's single drag context).
pub trait InputBackend {
    type Target;
    type Control: Ord + Clone;
    type Packet;
    type Error;

    fn capabilities(&self) -> crate::capabilities::InputCapabilities {
        Default::default()
    }

    /// Release backend resources after this participant's retained releases were
    /// attempted. Default backends own no target-scoped native resources.
    fn closed(&mut self, _target: &Self::Target) {}
    fn refreshed(&mut self, _previous: &Self::Target, _next: &Self::Target) {}

    fn prepare<'a>(
        &mut self,
        target: &Self::Target,
        event: &InputEvent,
        held: impl Iterator<Item = (&'a Self::Control, &'a Self::Packet)>,
    ) -> Result<Prepared<Self::Control, Self::Packet>, Self::Error>
    where
        Self::Control: 'a,
        Self::Packet: 'a;

    fn post(
        &mut self,
        target: &Self::Target,
        packet: &Self::Packet,
    ) -> Result<Delivery, PostFailure<Self::Error>>;
}

#[derive(Debug)]
pub enum InputFailure<E> {
    Ownership(OwnershipError),
    Invalid(crate::error::ValidationError),
    Prepare(E),
    Post {
        failure: PostFailure<E>,
        cleanup: Vec<PostFailure<E>>,
    },
}
impl<E> From<OwnershipError> for InputFailure<E> {
    fn from(value: OwnershipError) -> Self {
        Self::Ownership(value)
    }
}

pub type Preparation<B> = Result<
    Prepared<<B as InputBackend>::Control, <B as InputBackend>::Packet>,
    InputFailure<<B as InputBackend>::Error>,
>;

/// A synchronous, single-dispatch host. It never sleeps or owns a macro clock.
/// A scheduler supplies individual due events; continuous clients submit events
/// across calls using the same participant. Adapters own authority checks.
pub struct InputHost<B: InputBackend> {
    backend: B,
    ownership: Ownership<B::Control, B::Packet>,
    targets: BTreeMap<Participant, B::Target>,
}
impl<B: InputBackend> InputHost<B> {
    pub fn new(backend: B, max_sessions: usize, max_held: usize) -> Self {
        Self {
            backend,
            ownership: Ownership::new(max_sessions, max_held),
            targets: BTreeMap::new(),
        }
    }
    pub fn capabilities(&self) -> crate::capabilities::InputCapabilities {
        self.backend.capabilities()
    }
    pub fn open(
        &mut self,
        identity: TargetIdentity,
        collision_domain: String,
        target: B::Target,
    ) -> Result<Participant, OwnershipError> {
        let owner = self.ownership.open(identity, collision_domain)?;
        self.targets.insert(owner, target);
        Ok(owner)
    }
    pub fn held_count(&self, owner: Participant) -> Result<usize, OwnershipError> {
        self.ownership.held_count(owner)
    }
    pub fn target(&self, owner: Participant) -> Result<&TargetIdentity, OwnershipError> {
        self.ownership.target(owner)
    }
    /// Refresh authoritative geometry or per-operation delivery context without
    /// replacing the participant or moving its holds to a different target.
    pub fn update_destination(
        &mut self,
        owner: Participant,
        identity: &TargetIdentity,
        target: B::Target,
    ) -> Result<(), OwnershipError> {
        if self.ownership.target(owner)? != identity {
            return Err(OwnershipError::StaleInput);
        }
        self.unwind_scoped(owner, |host| {
            host.backend.refreshed(&host.targets[&owner], &target);
            host.targets.insert(owner, target);
        });
        Ok(())
    }
    /// Preallocate a typed event without dispatching or consuming a sequence.
    pub fn prepare(&mut self, owner: Participant, event: &InputEvent) -> Preparation<B> {
        self.ownership.target(owner)?;
        event.validate().map_err(InputFailure::Invalid)?;
        self.unwind_scoped(owner, |host| {
            host.backend
                .prepare(&host.targets[&owner], event, host.ownership.holds(owner)?)
                .map_err(InputFailure::Prepare)
        })
    }
    /// Backend-specific macro compilers may allocate packet resources through
    /// this hook. The callback must only prepare resources, never post input.
    /// This trusted in-process hook is not a transport or authorization boundary.
    pub fn compile<T>(
        &mut self,
        owner: Participant,
        compile: impl FnOnce(&mut B, &B::Target) -> Result<T, B::Error>,
    ) -> Result<T, InputFailure<B::Error>> {
        self.ownership.target(owner)?;
        self.unwind_scoped(owner, |host| {
            compile(&mut host.backend, &host.targets[&owner]).map_err(InputFailure::Prepare)
        })
    }
    pub fn submit(
        &mut self,
        owner: Participant,
        identity: &TargetIdentity,
        sequence: u64,
        event: &InputEvent,
    ) -> Result<Delivery, InputFailure<B::Error>> {
        // A stale target or replay must not revoke another live session's holds.
        self.accept(owner, identity, sequence)?;
        event.validate().map_err(InputFailure::Invalid)?;
        self.unwind_scoped(owner, |host| {
            let packet = host
                .backend
                .prepare(&host.targets[&owner], event, host.ownership.holds(owner)?)
                .map_err(InputFailure::Prepare)?;
            host.dispatch(owner, packet)
        })
    }
    /// For validated macro compilers that preallocate a complete sequence using
    /// the same backend. This avoids reallocation at each scheduled deadline.
    pub fn submit_prepared(
        &mut self,
        owner: Participant,
        identity: &TargetIdentity,
        sequence: u64,
        packet: Prepared<B::Control, B::Packet>,
    ) -> Result<Delivery, InputFailure<B::Error>> {
        self.accept(owner, identity, sequence)?;
        self.unwind_scoped(owner, |host| host.dispatch(owner, packet))
    }
    fn accept(
        &mut self,
        owner: Participant,
        target: &TargetIdentity,
        sequence: u64,
    ) -> Result<(), OwnershipError> {
        if self.ownership.target(owner)? != target {
            return Err(OwnershipError::StaleInput);
        }
        self.ownership.accept_sequence(owner, sequence)
    }
    fn unwind_scoped<T>(
        &mut self,
        owner: Participant,
        operation: impl FnOnce(&mut Self) -> T,
    ) -> T {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| operation(self))) {
            Ok(result) => result,
            Err(payload) => {
                let _ = self.close(owner);
                std::panic::resume_unwind(payload)
            }
        }
    }
    fn dispatch(
        &mut self,
        owner: Participant,
        prepared: Prepared<B::Control, B::Packet>,
    ) -> Result<Delivery, InputFailure<B::Error>> {
        // Roll back only when the backend certifies that no input was posted.
        // Unknown delivery retains the release for the last attempted position.
        let mut down = None;
        let mut moved = None;
        let mut up = false;
        let packet = match prepared {
            Prepared::Down {
                control,
                packet,
                release,
            } => {
                self.ownership.hold(owner, control.clone(), release)?;
                down = Some(control);
                packet
            }
            Prepared::Up { control, packet } => {
                let release = self.ownership.release(owner, &control)?;
                up = true;
                packet.unwrap_or(release)
            }
            Prepared::Repeat { control, packet } => {
                self.ownership.held(owner, &control)?;
                packet
            }
            Prepared::MoveHeld {
                control,
                packet,
                release,
            } => {
                let old = self.ownership.replace_release(owner, &control, release)?;
                moved = Some((control, old));
                packet
            }
            Prepared::Action { controls, packet } => {
                for control in controls {
                    self.ownership.available(owner, &control)?;
                }
                packet
            }
        };
        match self.backend.post(&self.targets[&owner], &packet) {
            Ok(receipt) => Ok(receipt),
            Err(failure) => {
                let mut cleanup = Vec::new();
                if matches!(failure, PostFailure::NotDispatched(_)) {
                    if let Some(control) = down {
                        let _ = self.ownership.release(owner, &control);
                    }
                    if let Some((control, release)) = moved {
                        let _ = self.ownership.update_release(owner, &control, release);
                    }
                    if up {
                        // This Up was definitely not sent. Make one cleanup
                        // attempt, never retry a possibly dispatched release.
                        if let Err(error) = self.backend.post(&self.targets[&owner], &packet) {
                            cleanup.push(error);
                        }
                    }
                }
                cleanup.extend(self.close(owner));
                Err(InputFailure::Post { failure, cleanup })
            }
        }
    }
    /// Idempotent close/cancel. Cleanup intentionally does not consult a cancelled
    /// request token: releases still need to run after the caller presses Stop.
    pub fn close(&mut self, owner: Participant) -> Vec<PostFailure<B::Error>> {
        let releases = self.ownership.close(owner);
        let Some(target) = self.targets.remove(&owner) else {
            return vec![];
        };
        let mut failures = Vec::new();
        for packet in releases {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                self.backend.post(&target, &packet)
            }));
            match result {
                Ok(Err(error)) => failures.push(error),
                Ok(Ok(_)) => {}
                // Continue releasing other controls even if a backend panics.
                // The original dispatch panic is resumed by unwind_scoped.
                Err(_) => failures.push(PostFailure::BackendPanicked),
            }
        }
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.backend.closed(&target)
        }))
        .is_err()
        {
            failures.push(PostFailure::BackendPanicked);
        }
        failures
    }
}
impl<B: InputBackend> Drop for InputHost<B> {
    fn drop(&mut self) {
        let owners: Vec<_> = self.ownership.participants().collect();
        for owner in owners {
            let _ = self.close(owner);
        }
    }
}
