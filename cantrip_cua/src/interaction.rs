//! Trusted worker participant adapter. Remote grants are verified by the worker;
//! this endpoint is not exposed to JavaScript and never fabricates agent authority.
use crate::{
    backend::CaptureBackend,
    cancellation::Cancellation,
    cursor::{CursorAppearance, CursorState},
    error::{CuaError, ErrorCode, Result},
    target::{MAX_SEQUENCE, Target, TargetKind, validate_id},
};
use cantrip_interaction::{
    input::{InputEvent, InputScope},
    presentation::CursorPresentation,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub worker_id: String,
    pub surface_id: String,
    pub attachment_id: String,
    pub participant_id: String,
}
impl Binding {
    fn validate(&self) -> Result<()> {
        for id in [
            &self.worker_id,
            &self.surface_id,
            &self.attachment_id,
            &self.participant_id,
        ] {
            validate_id(id)?;
        }
        Ok(())
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Open {
        binding: Binding,
        target_id: String,
        target_generation: u64,
    },
    Input {
        binding: Binding,
        handle: u64,
        sequence: u64,
        event: InputEvent,
    },
    Close {
        binding: Binding,
        handle: u64,
    },
    /// Releases an open whose response was lost, without needing its handle.
    CloseBinding {
        binding: Binding,
    },
}
struct Participant {
    binding: Binding,
    native_id: String,
    target: Target,
    cursor: CursorState,
    sequence: u64,
}
#[derive(Default)]
pub struct Participants {
    next_handle: u64,
    live: HashMap<u64, Participant>,
}
impl Participants {
    fn get(&self, handle: u64, binding: &Binding) -> Result<&Participant> {
        binding.validate()?;
        let state = self.live.get(&handle).ok_or_else(|| {
            CuaError::new(
                ErrorCode::SessionNotFound,
                "Interaction participant is closed or belongs to an earlier helper.",
            )
        })?;
        if &state.binding != binding {
            return Err(CuaError::new(
                ErrorCode::OwnershipMismatch,
                "Interaction participant belongs to another attachment.",
            ));
        }
        Ok(state)
    }
    fn close(&mut self, backend: &mut impl CaptureBackend, handle: u64) -> Result<()> {
        if let Some(state) = self.live.remove(&handle) {
            backend.close_input(&state.native_id)?;
        }
        Ok(())
    }
    pub fn execute(
        &mut self,
        backend: &mut impl CaptureBackend,
        request: Request,
        cancel: &Cancellation,
        now: u64,
    ) -> Result<Value> {
        let result = self.execute_inner(backend, request, cancel, now);
        backend.present_interaction_cursors(
            self.live
                .values()
                .map(|state| CursorPresentation {
                    participant_id: state.native_id.clone(),
                    appearance_identity: state.binding.participant_id.clone(),
                    target: Some(state.target.clone()),
                    cursor: state.cursor.clone(),
                })
                .collect(),
        );
        result
    }
    fn execute_inner(
        &mut self,
        backend: &mut impl CaptureBackend,
        request: Request,
        cancel: &Cancellation,
        now: u64,
    ) -> Result<Value> {
        match request {
            Request::Open {
                binding,
                target_id,
                target_generation,
            } => {
                binding.validate()?;
                validate_id(&target_id)?;
                cancel.check()?;
                if self.live.len() >= 16 {
                    return Err(CuaError::new(
                        ErrorCode::Capacity,
                        "Interaction participant capacity reached.",
                    ));
                }
                let target = backend.resolve_target(&target_id, target_generation, cancel)?;
                target.validate()?;
                if target.kind != TargetKind::Window {
                    return Err(CuaError::new(
                        ErrorCode::Unsupported,
                        "Independent input requires a window target; global input is not substituted.",
                    ));
                }
                if target.id != target_id || target.generation != target_generation {
                    return Err(CuaError::new(
                        ErrorCode::StaleTarget,
                        "Interaction target was replaced.",
                    ));
                }
                cancel.check()?;
                self.next_handle = self
                    .next_handle
                    .checked_add(1)
                    .filter(|v| *v <= MAX_SEQUENCE)
                    .ok_or_else(|| {
                        CuaError::new(ErrorCode::Capacity, "Interaction handles exhausted.")
                    })?;
                let handle = self.next_handle;
                let cursor = CursorState {
                    appearance: CursorAppearance::for_identity(&binding.participant_id),
                    ..CursorState::default()
                };
                let result = json!({"handle":handle,"target":target,"cursor":cursor,"sprite":crate::interaction_sprite::sprite(&cursor)});
                self.live.insert(
                    handle,
                    Participant {
                        binding,
                        native_id: format!("remote\0{handle}"),
                        target,
                        cursor,
                        sequence: 0,
                    },
                );
                Ok(result)
            }
            Request::CloseBinding { binding } => {
                binding.validate()?;
                let handles: Vec<_> = self
                    .live
                    .iter()
                    .filter_map(|(handle, state)| (state.binding == binding).then_some(*handle))
                    .collect();
                let mut failure = None;
                for handle in handles {
                    if let Err(error) = self.close(backend, handle) {
                        failure = Some(error);
                    }
                }
                if let Some(error) = failure {
                    return Err(error);
                }
                Ok(json!({"closed":true}))
            }
            Request::Close { binding, handle } => {
                self.get(handle, &binding)?;
                // Cleanup is allowed even if the originating request was cancelled.
                self.close(backend, handle)?;
                Ok(json!({"closed":true}))
            }
            Request::Input {
                binding,
                handle,
                sequence,
                event,
            } => {
                let state = self.get(handle, &binding)?;
                if sequence == 0 || sequence > MAX_SEQUENCE || sequence <= state.sequence {
                    return Err(CuaError::invalid(
                        "Stale interaction sequence; no input was posted.",
                    ));
                }
                event.validate()?;
                if event.scope() != InputScope::Surface {
                    return Err(CuaError::new(
                        ErrorCode::Unsupported,
                        "Remote window input cannot change host focus or send system media events.",
                    ));
                }
                // Consume once, before dispatch. Failed or uncertain actions are never replayed.
                self.live.get_mut(&handle).unwrap().sequence = sequence;
                let result = (|| {
                    cancel.check()?;
                    let state = self.live.get_mut(&handle).unwrap();
                    let target = backend.resolve_target(
                        &state.target.id,
                        state.target.generation,
                        cancel,
                    )?;
                    target.validate()?;
                    if target.id != state.target.id
                        || target.generation != state.target.generation
                        || target.process_id != state.target.process_id
                        || target.kind != TargetKind::Window
                    {
                        return Err(CuaError::new(
                            ErrorCode::StaleTarget,
                            "Interaction target was replaced.",
                        ));
                    }
                    let point = match &event {
                        InputEvent::PointerMove { point, .. }
                        | InputEvent::PointerDown { point, .. }
                        | InputEvent::PointerUp { point, .. }
                        | InputEvent::Scroll { point, .. } => Some(*point),
                        _ => None,
                    };
                    if let Some(point) = point {
                        state.cursor.move_to(point, &target.bounds, now)?;
                    }
                    state.target = target;
                    let clicking = matches!(event, InputEvent::PointerDown { .. });
                    backend.interaction_input(
                        &state.native_id,
                        &state.target,
                        state.cursor.position,
                        sequence,
                        event,
                        cancel,
                    )?;
                    cancel.check()?;
                    if clicking {
                        state
                            .cursor
                            .mark_action("remote-pointer", "dispatched", now);
                    }
                    Ok(
                        json!({"handle":handle,"sequence":sequence,"outcome":"dispatched","windowDelivery":"unverified","cursor":state.cursor}),
                    )
                })();
                if result.is_err() {
                    // A failure ends this participant only, including all held controls.
                    if self.close(backend, handle).is_err() {
                        return Err(CuaError::new(
                            ErrorCode::InputUnknown,
                            "Input cleanup was uncertain; do not replay.",
                        ));
                    }
                }
                result
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        backend::{Capture, FakeBackend},
        target::Point,
    };
    #[derive(Default)]
    struct Backend {
        fake: FakeBackend,
        posts: Vec<(String, InputEvent)>,
        closed: Vec<String>,
        presented: Vec<CursorPresentation<Target>>,
        fail: bool,
        replaced: bool,
    }
    impl CaptureBackend for Backend {
        fn name(&self) -> &'static str {
            "test"
        }
        fn available(&self) -> bool {
            true
        }
        fn targets(&mut self, cancel: &Cancellation) -> Result<Vec<Target>> {
            let mut targets = self.fake.targets(cancel)?;
            if self.replaced {
                for target in &mut targets {
                    target.generation += 1;
                }
            }
            Ok(targets)
        }
        fn capture(&mut self, target: &Target, cancel: &Cancellation) -> Result<Capture> {
            self.fake.capture(target, cancel)
        }
        fn interaction_input(
            &mut self,
            participant: &str,
            _: &Target,
            _: Point,
            _: u64,
            event: InputEvent,
            _: &Cancellation,
        ) -> Result<()> {
            self.posts.push((participant.into(), event));
            if self.fail {
                Err(CuaError::new(ErrorCode::InputUnknown, "uncertain fixture"))
            } else {
                Ok(())
            }
        }
        fn close_input(&mut self, participant: &str) -> Result<()> {
            self.closed.push(participant.into());
            Ok(())
        }
        fn present_interaction_cursors(&mut self, participants: Vec<CursorPresentation<Target>>) {
            self.presented = participants;
        }
    }
    fn binding(name: &str) -> Binding {
        Binding {
            worker_id: "worker".into(),
            surface_id: "surface".into(),
            attachment_id: name.into(),
            participant_id: name.into(),
        }
    }
    fn open(p: &mut Participants, b: &mut Backend, name: &str) -> u64 {
        p.execute(
            b,
            Request::Open {
                binding: binding(name),
                target_id: "fake-window".into(),
                target_generation: 1,
            },
            &Cancellation::default(),
            1,
        )
        .unwrap()["handle"]
            .as_u64()
            .unwrap()
    }
    fn key(handle: u64, name: &str, sequence: u64) -> Request {
        Request::Input {
            binding: binding(name),
            handle,
            sequence,
            event: InputEvent::KeyDown {
                key: "A".into(),
                modifiers: vec![],
                repeat: false,
            },
        }
    }
    #[test]
    fn participant_handles_scope_reconnect_cleanup_and_sequence_fences() {
        let mut p = Participants::default();
        let mut b = Backend::default();
        let a = open(&mut p, &mut b, "a");
        let other = open(&mut p, &mut b, "b");
        assert_eq!(b.presented.len(), 2);
        let cancel = Cancellation::default();
        p.execute(&mut b, key(a, "a", 1), &cancel, 2).unwrap();
        assert_eq!(
            p.execute(&mut b, key(a, "a", 1), &cancel, 3)
                .unwrap_err()
                .code,
            ErrorCode::InvalidRequest
        );
        assert_eq!(
            p.execute(&mut b, key(a, "b", 2), &cancel, 3)
                .unwrap_err()
                .code,
            ErrorCode::OwnershipMismatch
        );
        assert_eq!(b.posts.len(), 1);
        p.execute(
            &mut b,
            Request::Close {
                binding: binding("a"),
                handle: a,
            },
            &cancel,
            4,
        )
        .unwrap();
        assert_eq!(b.closed, vec![format!("remote\0{a}")]);
        assert_eq!(b.presented.len(), 1);
        let replacement = open(&mut p, &mut b, "a");
        assert_ne!(replacement, a);
        assert_eq!(
            p.execute(&mut b, key(a, "a", 2), &cancel, 5)
                .unwrap_err()
                .code,
            ErrorCode::SessionNotFound
        );
        p.execute(&mut b, key(other, "b", 1), &cancel, 5).unwrap();
        p.execute(&mut b, key(replacement, "a", 1), &cancel, 5)
            .unwrap();
        assert_eq!(b.posts.len(), 3);
    }
    #[test]
    fn uncertain_dispatch_and_target_replacement_close_only_their_participant() {
        let mut p = Participants::default();
        let mut b = Backend::default();
        let a = open(&mut p, &mut b, "a");
        let other = open(&mut p, &mut b, "b");
        b.fail = true;
        assert_eq!(
            p.execute(&mut b, key(a, "a", 1), &Cancellation::default(), 2)
                .unwrap_err()
                .code,
            ErrorCode::InputUnknown
        );
        assert_eq!(b.posts.len(), 1);
        assert_eq!(b.presented.len(), 1);
        b.fail = false;
        b.replaced = true;
        assert_eq!(
            p.execute(&mut b, key(other, "b", 1), &Cancellation::default(), 3)
                .unwrap_err()
                .code,
            ErrorCode::StaleTarget
        );
        assert_eq!(b.posts.len(), 1);
        assert_eq!(b.closed.len(), 2);
        assert!(b.presented.is_empty());
    }
    #[test]
    fn canceled_input_releases_existing_participant_and_keeps_others() {
        let mut p = Participants::default();
        let mut b = Backend::default();
        let a = open(&mut p, &mut b, "a");
        open(&mut p, &mut b, "b");
        let cancel = Cancellation::default();
        cancel.cancel();
        assert_eq!(
            p.execute(&mut b, key(a, "a", 1), &cancel, 2)
                .unwrap_err()
                .code,
            ErrorCode::Cancelled
        );
        assert!(b.posts.is_empty());
        assert_eq!(b.closed.len(), 1);
        assert_eq!(b.presented.len(), 1);
    }
    #[test]
    fn monitor_and_host_scope_never_fall_back_to_system_input() {
        let mut p = Participants::default();
        let mut b = Backend::default();
        let cancel = Cancellation::default();
        assert_eq!(
            p.execute(
                &mut b,
                Request::Open {
                    binding: binding("a"),
                    target_id: "fake-monitor".into(),
                    target_generation: 1
                },
                &cancel,
                1
            )
            .unwrap_err()
            .code,
            ErrorCode::Unsupported
        );
        let handle = open(&mut p, &mut b, "a");
        assert_eq!(
            p.execute(
                &mut b,
                Request::Input {
                    binding: binding("a"),
                    handle,
                    sequence: 1,
                    event: InputEvent::RequestHostFocus
                },
                &cancel,
                2
            )
            .unwrap_err()
            .code,
            ErrorCode::Unsupported
        );
        assert!(b.posts.is_empty());
        let point = Point { x: 25., y: 30. };
        let result = p
            .execute(
                &mut b,
                Request::Input {
                    binding: binding("a"),
                    handle,
                    sequence: 1,
                    event: InputEvent::PointerMove {
                        point,
                        modifiers: vec![],
                    },
                },
                &cancel,
                3,
            )
            .unwrap();
        assert_eq!(result["windowDelivery"], "unverified");
        assert_eq!(b.presented[0].cursor.position, point);
    }
    #[test]
    fn lost_open_response_can_be_cleaned_by_exact_attachment_binding() {
        let mut p = Participants::default();
        let mut b = Backend::default();
        open(&mut p, &mut b, "a");
        open(&mut p, &mut b, "a");
        open(&mut p, &mut b, "b");
        let cancel = Cancellation::default();
        cancel.cancel();
        for _ in 0..2 {
            p.execute(
                &mut b,
                Request::CloseBinding {
                    binding: binding("a"),
                },
                &cancel,
                1,
            )
            .unwrap();
        }
        assert_eq!(b.closed.len(), 2);
        assert_eq!(b.presented.len(), 1);
        assert_eq!(b.presented[0].appearance_identity, "b");
    }
    #[test]
    fn service_routes_worker_participants_without_agent_binding_and_allows_cancelled_cleanup() {
        use crate::service::{CuaService, Operation};
        let mut service = CuaService::new(Backend::default());
        let open = service
            .execute(
                Operation::Interaction {
                    request: Request::Open {
                        binding: binding("a"),
                        target_id: "fake-window".into(),
                        target_generation: 1,
                    },
                },
                &Cancellation::default(),
                1,
            )
            .unwrap();
        assert_eq!(service.session_count(), 0);
        let handle = open.data["handle"].as_u64().unwrap();
        let cancel = Cancellation::default();
        cancel.cancel();
        service
            .execute(
                Operation::Interaction {
                    request: Request::Close {
                        binding: binding("a"),
                        handle,
                    },
                },
                &cancel,
                2,
            )
            .unwrap();
        assert_eq!(
            service
                .execute(
                    Operation::Interaction {
                        request: key(handle, "a", 1)
                    },
                    &Cancellation::default(),
                    3
                )
                .err()
                .unwrap()
                .code,
            ErrorCode::SessionNotFound
        );
    }
    #[test]
    fn wire_events_retain_holds_modifiers_and_reject_extra_authority() {
        let request = json!({"type":"input","binding":binding("a"),"handle":1,"sequence":1,"event":{"type":"keyDown","data":{"key":"k","modifiers":["Meta"],"repeat":false}}});
        let parsed: Request = serde_json::from_value(request.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), request);
        let mut invalid = request;
        invalid["processId"] = json!(123);
        assert!(serde_json::from_value::<Request>(invalid).is_err());
    }
}
