//! Reusable native participant lifetime. No agent, MCP, or turn identifiers.
//! Callers supply authorized target metadata and presentation identity; this
//! module does not discover authority or silently activate the host desktop.
use super::input_backend::{Control, Destination, NativeInput, Packet};
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::{Point, Target},
};
use cantrip_interaction::{
    host::{Delivery, InputFailure, InputHost, PostFailure, Prepared},
    input::InputEvent,
    ownership::{Participant, TargetIdentity},
};
use std::sync::{Arc, Mutex, MutexGuard};

type Shared = Arc<Mutex<InputHost<NativeInput>>>;
/// Clones share one ownership registry; native event sources remain participant-scoped. Locks cover only
/// preparation/delivery, never gesture delays, capture, or cursor interpolation.
#[derive(Clone)]
pub struct NativeInputHost {
    shared: Shared,
}
impl Default for NativeInputHost {
    fn default() -> Self {
        Self::new(16, 17)
    }
}
impl NativeInputHost {
    pub fn new(max_participants: usize, max_held_controls: usize) -> Self {
        Self {
            shared: Arc::new(Mutex::new(InputHost::new(
                NativeInput::new(),
                max_participants,
                max_held_controls,
            ))),
        }
    }
    pub fn capabilities(&self) -> cantrip_interaction::capabilities::InputCapabilities {
        lock(&self.shared).capabilities()
    }
    pub fn open(
        &self,
        participant: String,
        target: Target,
        position: Point,
    ) -> Result<NativeInputSession> {
        target.validate()?;
        let identity = identity(&target);
        let destination = Destination {
            participant,
            target,
            position,
            cancel: Cancellation::default(),
            group: super::skylight::next_group(),
        };
        // Several windows in one process can share responder keyboard/mouse
        // state. Use the process domain rather than claiming per-window isolation.
        let domain = match destination.target.process_id {
            Some(pid) => format!("process:{pid}"),
            None => format!("target:{}:{}", identity.id, identity.generation),
        };
        let owner = lock(&self.shared)
            .open(identity.clone(), domain, destination.clone())
            .map_err(|error| failure(InputFailure::Ownership(error)))?;
        Ok(NativeInputSession {
            shared: self.shared.clone(),
            owner,
            identity,
            destination,
            sequence: 0,
        })
    }
}
/// A live participant. Holds persist until explicit Up, close/Drop, cancellation,
/// or delivery failure. A new session always gets a new ownership token.
pub struct NativeInputSession {
    shared: Shared,
    owner: Participant,
    identity: TargetIdentity,
    destination: Destination,
    sequence: u64,
}
fn identity(target: &Target) -> TargetIdentity {
    TargetIdentity {
        id: target.id.clone(),
        generation: target.generation,
    }
}
fn lock(shared: &Shared) -> MutexGuard<'_, InputHost<NativeInput>> {
    // InputHost unwinds only after restoring scoped ownership. Poison from one
    // participant's backend panic must not strand other participants' releases.
    shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
impl NativeInputSession {
    pub fn target_identity(&self) -> &TargetIdentity {
        &self.identity
    }
    pub fn refresh(
        &mut self,
        target: Target,
        position: Point,
        cancel: &Cancellation,
    ) -> Result<()> {
        target.validate()?;
        if identity(&target) != self.identity
            || target.process_id != self.destination.target.process_id
            || target.kind != self.destination.target.kind
        {
            return Err(CuaError::new(
                ErrorCode::StaleTarget,
                "An input session cannot be rebound to a replacement target.",
            ));
        }
        let destination = Destination {
            target,
            position,
            cancel: cancel.clone(),
            participant: self.destination.participant.clone(),
            group: self.destination.group,
        };
        lock(&self.shared)
            .update_destination(self.owner, &self.identity, destination.clone())
            .map_err(|error| failure(InputFailure::Ownership(error)))?;
        self.destination = destination;
        Ok(())
    }
    fn context(&mut self, cancel: &Cancellation) -> Result<()> {
        self.refresh(
            self.destination.target.clone(),
            self.destination.position,
            cancel,
        )
    }
    /// Explicit transport sequence; replays/reordering are rejected by the host.
    /// The adapter must map its own authorization and exact target to this handle.
    pub fn submit(
        &mut self,
        sequence: u64,
        event: InputEvent,
        cancel: &Cancellation,
    ) -> Result<Delivery> {
        self.context(cancel)?;
        self.sequence = self.sequence.max(sequence);
        let result = lock(&self.shared)
            .submit(self.owner, &self.identity, sequence, &event)
            .map_err(failure);
        if result.is_ok() {
            match event {
                InputEvent::PointerDown { point, .. }
                | InputEvent::PointerUp { point, .. }
                | InputEvent::PointerMove { point, .. }
                | InputEvent::Scroll { point, .. } => self.destination.position = point,
                _ => {}
            }
        }
        if cancel.is_cancelled()
            && (result.is_ok()
                || result.as_ref().is_err_and(|e| {
                    matches!(e.code, ErrorCode::Cancelled | ErrorCode::InputUnknown)
                }))
        {
            let _ = self.close();
        }
        result
    }
    /// In-process ordered submission. Network adapters should use submit with
    /// their original sequence instead of numbering a replay as a new event.
    pub fn send(&mut self, event: InputEvent, cancel: &Cancellation) -> Result<Delivery> {
        let sequence = self.next_sequence()?;
        self.submit(sequence, event, cancel)
    }
    fn next_sequence(&mut self) -> Result<u64> {
        self.sequence = self.sequence.checked_add(1).ok_or_else(|| {
            CuaError::new(ErrorCode::Capacity, "Native input sequence exhausted.")
        })?;
        Ok(self.sequence)
    }
    /// End participant lifetime (including idle held input). Operation
    /// Cancellation tokens only cancel their submitted operation; adapters call
    /// close when a participant disconnects or its authority is revoked.
    pub fn close(&mut self) -> Result<()> {
        if lock(&self.shared).close(self.owner).is_empty() {
            Ok(())
        } else {
            Err(unknown())
        }
    }
    /// Compatibility/semantic native actions share ownership without pretending
    /// an accessibility activation is a physical key or mouse packet.
    pub(super) fn action<T>(
        &mut self,
        controls: &[Control],
        cancel: &Cancellation,
        action: impl FnOnce() -> Result<T>,
    ) -> Result<T> {
        self.context(cancel)?;
        let sequence = self.next_sequence()?;
        lock(&self.shared)
            .submit_action(self.owner, &self.identity, sequence, controls, |_, _| {
                cancel.check().map_err(PostFailure::NotDispatched)?;
                action().map_err(|error| {
                    if error.code == ErrorCode::InputUnknown {
                        PostFailure::Uncertain(error)
                    } else {
                        PostFailure::NotDispatched(error)
                    }
                })
            })
            .map_err(failure)
    }
    pub(super) fn begin_macro(
        &mut self,
        target: Target,
        position: Point,
        cancel: &Cancellation,
    ) -> Result<()> {
        self.refresh(target, position, cancel)?;
        // CUA macros are balanced. A fresh event source/group preserves their
        // previous per-macro native semantics; continuous sessions retain theirs.
        if lock(&self.shared)
            .held_count(self.owner)
            .map_err(|error| failure(InputFailure::Ownership(error)))?
            != 0
        {
            return Err(CuaError::invalid(
                "A balanced macro cannot replace an active continuous hold.",
            ));
        }
        self.destination.group = super::skylight::next_group();
        lock(&self.shared)
            .update_destination(self.owner, &self.identity, self.destination.clone())
            .map_err(|error| failure(InputFailure::Ownership(error)))
    }
    pub(super) fn prepare(&mut self, event: &InputEvent) -> Result<Prepared<Control, Packet>> {
        lock(&self.shared)
            .prepare(self.owner, event)
            .map_err(failure)
    }
    pub(super) fn key_pair(
        &mut self,
        key: u16,
        text: &[u16],
        modifiers: &[crate::gesture::Modifier],
    ) -> Result<Prepared<Control, Packet>> {
        lock(&self.shared)
            .compile(self.owner, |backend, target| {
                backend.key_pair(target, key, text, modifiers)
            })
            .map_err(failure)
    }
    pub(super) fn prepared(&mut self, packet: Prepared<Control, Packet>) -> Result<()> {
        let sequence = self.next_sequence()?;
        lock(&self.shared)
            .submit_prepared(self.owner, &self.identity, sequence, packet)
            .map(|_| ())
            .map_err(failure)
    }
}
impl Drop for NativeInputSession {
    fn drop(&mut self) {
        let _ = self.close();
    }
}
pub(super) fn unknown() -> CuaError {
    CuaError::new(
        ErrorCode::InputUnknown,
        "Input stopped after dispatch may have begun; participant-scoped release cleanup was attempted. Do not replay automatically.",
    )
}
fn failure(error: InputFailure<CuaError>) -> CuaError {
    match error {
        InputFailure::Prepare(error) => error,
        InputFailure::Invalid(error) => CuaError::invalid(error.to_string()),
        InputFailure::Ownership(cantrip_interaction::ownership::OwnershipError::Capacity) => {
            CuaError::new(
                ErrorCode::Capacity,
                "Native input participant or held-control capacity reached.",
            )
        }
        InputFailure::Ownership(
            cantrip_interaction::ownership::OwnershipError::SessionNotFound,
        ) => CuaError::new(
            ErrorCode::SessionNotFound,
            "Native input participant is closed.",
        ),
        InputFailure::Ownership(error) => CuaError::invalid(format!(
            "Input ownership rejected the operation: {error:?}. No input was posted."
        )),
        InputFailure::Post {
            failure: PostFailure::NotDispatched(error),
            cleanup,
        } if cleanup.is_empty() => error,
        InputFailure::Post { .. } => unknown(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target() -> Target {
        Target {
            id: "macos-window-123".into(),
            generation: 1,
            kind: crate::target::TargetKind::Window,
            title: None,
            application: None,
            process_id: Some(77),
            bounds: crate::target::Bounds {
                x: 100.,
                y: 200.,
                width: 500.,
                height: 400.,
            },
            pixel_width: 500,
            pixel_height: 400,
            scale_factor: 1.,
            focused: None,
            minimized: None,
        }
    }
    fn open(host: &NativeInputHost, id: &str) -> NativeInputSession {
        host.open(id.into(), target(), Point { x: 10., y: 20. })
            .unwrap()
    }
    #[test]
    fn semantic_action_preserves_results_and_cancellation_closes_only_its_owner() {
        let host = NativeInputHost::new(2, 17);
        let mut a = open(&host, "a");
        let mut b = open(&host, "b");
        let result = a
            .action(&[], &Cancellation::default(), || Ok(("native-result", 42)))
            .unwrap();
        assert_eq!(result, ("native-result", 42));
        let cancel = Cancellation::default();
        cancel.cancel();
        assert_eq!(
            a.action::<()>(&[], &cancel, || panic!("cancelled action was invoked"))
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert_eq!(
            a.refresh(target(), Point::default(), &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::SessionNotFound
        );
        b.action(&[], &Cancellation::default(), || Ok(())).unwrap();
        let _replacement = open(&host, "replacement");
        // Closures above record adapter behavior only; no native input is posted.
    }
    #[test]
    fn cloned_hosts_share_capacity_and_dropping_one_participant_frees_only_its_slot() {
        let host = NativeInputHost::new(2, 17);
        let mut a = open(&host, "a");
        let mut b = open(&host.clone(), "b");
        assert_eq!(
            host.open("c".into(), target(), Point { x: 0., y: 0. })
                .err()
                .unwrap()
                .code,
            ErrorCode::Capacity
        );
        a.close().unwrap();
        a.close().unwrap();
        let c = open(&host, "c");
        b.refresh(target(), Point { x: 20., y: 30. }, &Cancellation::default())
            .unwrap();
        assert_eq!(
            a.refresh(target(), Point { x: 20., y: 30. }, &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::SessionNotFound
        );
        drop(c);
        drop(b);
        for _ in 0..1000 {
            drop(open(&host, "reused appearance identity"));
        }
    }
    #[test]
    fn refresh_cannot_transfer_an_input_session_to_a_replacement_or_other_process() {
        let host = NativeInputHost::default();
        let mut session = open(&host, "a");
        let mut next = target();
        next.generation += 1;
        assert_eq!(
            session
                .refresh(next, Point { x: 0., y: 0. }, &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::StaleTarget
        );
        let mut next = target();
        next.process_id = Some(88);
        assert_eq!(
            session
                .refresh(next, Point { x: 0., y: 0. }, &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::StaleTarget
        );
        let mut resized = target();
        resized.bounds.width += 100.;
        session
            .refresh(resized, Point { x: 0., y: 0. }, &Cancellation::default())
            .unwrap();
    }
    #[test]
    fn cancelled_authorized_call_closes_only_its_participant_without_posting_input() {
        let host = NativeInputHost::default();
        let mut a = open(&host, "a");
        let mut b = open(&host, "b");
        let cancel = Cancellation::default();
        cancel.cancel();
        let event = InputEvent::KeyDown {
            key: "A".into(),
            modifiers: vec![],
            repeat: false,
        };
        assert_eq!(
            a.submit(1, event, &cancel).unwrap_err().code,
            ErrorCode::Cancelled
        );
        assert_eq!(
            a.refresh(target(), Point { x: 0., y: 0. }, &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::SessionNotFound
        );
        b.refresh(target(), Point { x: 0., y: 0. }, &Cancellation::default())
            .unwrap();
    }
    #[test]
    fn stale_cancelled_submission_does_not_close_live_participant() {
        let host = NativeInputHost::default();
        let mut a = open(&host, "a");
        let event = InputEvent::KeyDown {
            key: "unsupported key".into(),
            modifiers: vec![],
            repeat: false,
        };
        // Unsupported translation does not reach native event posting.
        assert_eq!(
            a.submit(2, event.clone(), &Cancellation::default())
                .unwrap_err()
                .code,
            ErrorCode::Unsupported
        );
        let cancel = Cancellation::default();
        cancel.cancel();
        assert_eq!(
            a.submit(1, event, &cancel).unwrap_err().code,
            ErrorCode::InvalidRequest
        );
        a.refresh(target(), Point { x: 0., y: 0. }, &Cancellation::default())
            .unwrap();
    }
    #[test]
    fn capability_description_does_not_require_capture_permissions_or_initialize_delivery() {
        use cantrip_interaction::capabilities::{PointerIsolation, Support};
        let host = NativeInputHost::default();
        let capabilities = host.capabilities();
        assert_eq!(capabilities.pointer, PointerIsolation::SurfaceDirected);
        assert_eq!(capabilities.buttons.len(), 5);
        assert_eq!(capabilities.persistent_holds, Support::Implemented);
        assert_eq!(capabilities.composition, Support::NotImplemented);
        assert_eq!(capabilities.simultaneous_pointer_holds, Some(1));
    }
    #[test]
    fn a_session_and_its_prepared_resources_can_move_between_worker_threads() {
        let host = NativeInputHost::default();
        let mut a = open(&host, "a");
        let packet = a.key_pair(0, &[], &[]).unwrap();
        std::thread::spawn(move || {
            drop(packet);
            a.close().unwrap();
        })
        .join()
        .unwrap();
        // Allocation, movement and release of event buffers only; no OS input.
    }
}
