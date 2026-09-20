//! Participant-scoped input ownership. This owns prepared release resources, not
//! authority: adapters authorize calls and dispatch returned releases exactly once.
use std::{
    collections::BTreeMap,
    sync::atomic::{AtomicU64, Ordering},
};
static NEXT_REGISTRY: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct TargetIdentity {
    pub id: String,
    pub generation: u64,
}
/// A process-local session generation. Closing/reopening the same visible
/// participant produces a different token, so delayed input cannot enter it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Participant {
    registry: u64,
    sequence: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnershipError {
    SessionNotFound,
    Capacity,
    AlreadyHeld,
    Conflict,
    NotHeld,
    StaleInput,
}

struct Hold<R> {
    release: R,
    ordinal: u64,
}
struct Session<C, R> {
    target: TargetIdentity,
    domain: String,
    holds: BTreeMap<C, Hold<R>>,
    ordinal: u64,
    last_sequence: Option<u64>,
}
/// `C` is the backend's collision key, not necessarily a public key name. Map
/// aliases to the same key. A backend may use a process-level domain when several
/// windows share input state. Multiple owners may hold different controls; a
/// second hold of the same control is rejected without disturbing its owner.
pub struct Ownership<C: Ord + Clone, R> {
    sessions: BTreeMap<Participant, Session<C, R>>,
    owners: BTreeMap<(String, C), Participant>,
    registry: u64,
    next: u64,
    max_sessions: usize,
    max_held: usize,
}
impl<C: Ord + Clone, R> Ownership<C, R> {
    pub fn new(max_sessions: usize, max_held: usize) -> Self {
        Self {
            sessions: BTreeMap::new(),
            owners: BTreeMap::new(),
            registry: NEXT_REGISTRY
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                    value.checked_add(1)
                })
                .unwrap_or(0),
            next: 0,
            max_sessions,
            max_held,
        }
    }
    pub fn open(
        &mut self,
        target: TargetIdentity,
        domain: String,
    ) -> Result<Participant, OwnershipError> {
        if self.registry == 0 || self.sessions.len() >= self.max_sessions {
            return Err(OwnershipError::Capacity);
        }
        self.next = self.next.checked_add(1).ok_or(OwnershipError::Capacity)?;
        let owner = Participant {
            registry: self.registry,
            sequence: self.next,
        };
        self.sessions.insert(
            owner,
            Session {
                target,
                domain,
                holds: BTreeMap::new(),
                ordinal: 0,
                last_sequence: None,
            },
        );
        Ok(owner)
    }
    pub fn target(&self, owner: Participant) -> Result<&TargetIdentity, OwnershipError> {
        self.sessions
            .get(&owner)
            .map(|s| &s.target)
            .ok_or(OwnershipError::SessionNotFound)
    }
    /// Fence transport reordering before dispatch, including uncertain results.
    /// Sequence numbers are per live participant, not timestamps or agent turns.
    pub fn accept_sequence(
        &mut self,
        owner: Participant,
        sequence: u64,
    ) -> Result<(), OwnershipError> {
        let session = self
            .sessions
            .get_mut(&owner)
            .ok_or(OwnershipError::SessionNotFound)?;
        if session
            .last_sequence
            .is_some_and(|previous| sequence <= previous)
        {
            return Err(OwnershipError::StaleInput);
        }
        session.last_sequence = Some(sequence);
        Ok(())
    }
    /// Check a real owned control without changing state. Used by transient
    /// operations (such as pointer tracking) that must not disrupt a held drag.
    pub fn available(&self, owner: Participant, control: &C) -> Result<(), OwnershipError> {
        let session = self
            .sessions
            .get(&owner)
            .ok_or(OwnershipError::SessionNotFound)?;
        match self.owners.get(&(session.domain.clone(), control.clone())) {
            Some(current) if *current == owner => Err(OwnershipError::AlreadyHeld),
            Some(_) => Err(OwnershipError::Conflict),
            None => Ok(()),
        }
    }
    /// Reserve only after the backend has prepared a matching release and before
    /// posting Down. Preparation must not itself post Down. If Down might have
    /// been posted, take/drain the release even when dispatch returns an error.
    pub fn hold(
        &mut self,
        owner: Participant,
        control: C,
        release: R,
    ) -> Result<(), OwnershipError> {
        let session = self
            .sessions
            .get_mut(&owner)
            .ok_or(OwnershipError::SessionNotFound)?;
        if session.holds.contains_key(&control) {
            return Err(OwnershipError::AlreadyHeld);
        }
        if session.holds.len() >= self.max_held {
            return Err(OwnershipError::Capacity);
        }
        let key = (session.domain.clone(), control.clone());
        if self.owners.contains_key(&key) {
            return Err(OwnershipError::Conflict);
        }
        session.ordinal = session
            .ordinal
            .checked_add(1)
            .ok_or(OwnershipError::Capacity)?;
        session.holds.insert(
            control,
            Hold {
                release,
                ordinal: session.ordinal,
            },
        );
        self.owners.insert(key, owner);
        Ok(())
    }
    /// Read only the caller's retained release (for key-repeat metadata, etc.).
    pub fn held(&self, owner: Participant, control: &C) -> Result<&R, OwnershipError> {
        self.sessions
            .get(&owner)
            .ok_or(OwnershipError::SessionNotFound)?
            .holds
            .get(control)
            .map(|h| &h.release)
            .ok_or(OwnershipError::NotHeld)
    }
    pub fn holds(
        &self,
        owner: Participant,
    ) -> Result<impl Iterator<Item = (&C, &R)>, OwnershipError> {
        let session = self
            .sessions
            .get(&owner)
            .ok_or(OwnershipError::SessionNotFound)?;
        Ok(session
            .holds
            .iter()
            .map(|(control, hold)| (control, &hold.release)))
    }
    /// Replace cleanup after a drag moves. Allocate the replacement before
    /// dispatching movement; never lose the existing release on preparation failure.
    pub fn update_release(
        &mut self,
        owner: Participant,
        control: &C,
        release: R,
    ) -> Result<(), OwnershipError> {
        self.replace_release(owner, control, release).map(|_| ())
    }
    pub fn replace_release(
        &mut self,
        owner: Participant,
        control: &C,
        release: R,
    ) -> Result<R, OwnershipError> {
        let hold = self
            .sessions
            .get_mut(&owner)
            .ok_or(OwnershipError::SessionNotFound)?
            .holds
            .get_mut(control)
            .ok_or(OwnershipError::NotHeld)?;
        Ok(std::mem::replace(&mut hold.release, release))
    }
    /// Remove ownership before dispatching Up. The caller must not replay an
    /// uncertain result. Repeated release cannot release another participant.
    pub fn release(&mut self, owner: Participant, control: &C) -> Result<R, OwnershipError> {
        let session = self
            .sessions
            .get_mut(&owner)
            .ok_or(OwnershipError::SessionNotFound)?;
        let hold = session
            .holds
            .remove(control)
            .ok_or(OwnershipError::NotHeld)?;
        self.owners
            .remove(&(session.domain.clone(), control.clone()));
        Ok(hold.release)
    }
    /// Idempotent close; returned releases are in reverse acquisition order.
    /// The adapter must attempt all releases even if one fails, then report any
    /// uncertainty. There is no automatic replay and no cross-owner cleanup.
    #[must_use = "Dispatch each returned cleanup release; do not silently discard held input."]
    pub fn close(&mut self, owner: Participant) -> Vec<R> {
        let Some(session) = self.sessions.remove(&owner) else {
            return vec![];
        };
        let mut holds: Vec<_> = session
            .holds
            .into_iter()
            .map(|(control, hold)| {
                self.owners.remove(&(session.domain.clone(), control));
                hold
            })
            .collect();
        holds.sort_by_key(|h| std::cmp::Reverse(h.ordinal));
        holds.into_iter().map(|h| h.release).collect()
    }
    pub fn participants(&self) -> impl Iterator<Item = Participant> + '_ {
        self.sessions.keys().copied()
    }
    pub fn held_count(&self, owner: Participant) -> Result<usize, OwnershipError> {
        self.sessions
            .get(&owner)
            .map(|s| s.holds.len())
            .ok_or(OwnershipError::SessionNotFound)
    }
}
