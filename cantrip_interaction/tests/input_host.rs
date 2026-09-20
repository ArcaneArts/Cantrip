use cantrip_interaction::{
    host::{Delivery, InputBackend, InputFailure, InputHost, PostFailure, Prepared},
    input::{InputEvent, Modifier},
    ownership::{OwnershipError, TargetIdentity},
};
use std::{cell::RefCell, rc::Rc};

#[derive(Clone, Debug, PartialEq)]
struct Packet {
    key: String,
    down: bool,
    modifiers: Vec<Modifier>,
}
#[derive(Default)]
struct State {
    events: Vec<(String, Packet)>,
    closed: Vec<String>,
    fail: Option<(String, bool, bool)>,
    panic: Option<(String, bool)>,
}
struct Recording(Rc<RefCell<State>>);
impl InputBackend for Recording {
    type Target = String;
    type Control = String;
    type Packet = Packet;
    type Error = &'static str;
    fn closed(&mut self, target: &String) {
        self.0.borrow_mut().closed.push(target.clone());
    }
    fn prepare<'a>(
        &mut self,
        _: &String,
        event: &InputEvent,
        mut held: impl Iterator<Item = (&'a String, &'a Packet)>,
    ) -> Result<Prepared<String, Packet>, Self::Error> {
        match event {
            InputEvent::KeyDown {
                key,
                modifiers,
                repeat,
            } => {
                let key = key.to_uppercase();
                if key == "UNSUPPORTED" {
                    return Err("unsupported key");
                }
                let packet = Packet {
                    key: key.clone(),
                    down: true,
                    modifiers: modifiers.clone(),
                };
                if *repeat {
                    let previous = held.find(|(c, _)| **c == key).ok_or("not held")?.1;
                    Ok(Prepared::Repeat {
                        control: key,
                        packet: Packet {
                            modifiers: previous.modifiers.clone(),
                            ..packet
                        },
                    })
                } else {
                    Ok(Prepared::Down {
                        control: key,
                        release: Packet {
                            down: false,
                            ..packet.clone()
                        },
                        packet,
                    })
                }
            }
            InputEvent::KeyUp { key } => Ok(Prepared::Up {
                control: key.to_uppercase(),
                packet: None,
            }),
            _ => Err("unsupported"),
        }
    }
    fn post(
        &mut self,
        target: &String,
        packet: &Packet,
    ) -> Result<Delivery, PostFailure<Self::Error>> {
        let mut state = self.0.borrow_mut();
        if state
            .panic
            .as_ref()
            .is_some_and(|(k, d)| *k == packet.key && *d == packet.down)
        {
            state.panic = None;
            panic!("backend panic");
        }
        if state
            .fail
            .as_ref()
            .is_some_and(|(k, d, _)| *k == packet.key && *d == packet.down)
        {
            let (_, _, uncertain) = state.fail.take().unwrap();
            if uncertain {
                state.events.push((target.clone(), packet.clone()));
                return Err(PostFailure::Uncertain("delivery"));
            }
            return Err(PostFailure::NotDispatched("delivery"));
        }
        state.events.push((target.clone(), packet.clone()));
        Ok(Delivery::DispatchedUnverified)
    }
}
fn target(generation: u64) -> TargetIdentity {
    TargetIdentity {
        id: "window".into(),
        generation,
    }
}
fn down(key: &str) -> InputEvent {
    InputEvent::KeyDown {
        key: key.into(),
        modifiers: vec![Modifier::Meta],
        repeat: false,
    }
}
fn up(key: &str) -> InputEvent {
    InputEvent::KeyUp { key: key.into() }
}
fn fixture() -> (InputHost<Recording>, Rc<RefCell<State>>) {
    let state = Rc::new(RefCell::new(State::default()));
    (InputHost::new(Recording(state.clone()), 8, 17), state)
}
#[test]
fn persistent_holds_aliases_and_modifiers_survive_separate_calls() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    host.submit(a, &target(1), 1, &down("a")).unwrap();
    assert_eq!(host.held_count(a), Ok(1));
    host.submit(
        a,
        &target(1),
        2,
        &InputEvent::KeyDown {
            key: "A".into(),
            modifiers: vec![],
            repeat: true,
        },
    )
    .unwrap();
    host.submit(a, &target(1), 3, &up("A")).unwrap();
    assert_eq!(host.held_count(a), Ok(0));
    assert!(host.close(a).is_empty());
    let events = &state.borrow().events;
    assert_eq!(events.len(), 3);
    assert!(events.iter().all(|(_, p)| p.modifiers == [Modifier::Meta]));
    assert_eq!(
        events.iter().map(|(_, p)| p.down).collect::<Vec<_>>(),
        [true, true, false]
    );
}
#[test]
fn real_shared_domain_conflicts_leave_other_participants_untouched() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    let b = host
        .open(target(2), "process".into(), "second".into())
        .unwrap();
    host.submit(a, &target(1), 1, &down("A")).unwrap();
    assert!(matches!(
        host.submit(b, &target(2), 1, &down("a")),
        Err(InputFailure::Ownership(OwnershipError::Conflict))
    ));
    host.submit(b, &target(2), 2, &down("B")).unwrap();
    host.close(a);
    assert_eq!(host.held_count(b), Ok(1));
    assert_eq!(state.borrow().events.last().unwrap().1.key, "A");
    host.close(a);
    assert_eq!(state.borrow().events.len(), 3);
    drop(host);
    assert_eq!(state.borrow().events.last().unwrap().1.key, "B");
    assert!(!state.borrow().events.last().unwrap().1.down);
}
#[test]
fn stale_target_sequence_and_closed_token_never_post_or_release() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    host.submit(a, &target(1), 7, &down("A")).unwrap();
    assert!(host.submit(a, &target(2), 8, &up("A")).is_err());
    assert!(host.submit(a, &target(1), 7, &up("A")).is_err());
    assert_eq!(host.held_count(a), Ok(1));
    host.close(a);
    let b = host
        .open(target(2), "process".into(), "second".into())
        .unwrap();
    assert!(host.submit(a, &target(1), 9, &down("B")).is_err());
    assert_eq!(host.held_count(b), Ok(0));
    assert_eq!(state.borrow().events.len(), 2);
}
#[test]
fn uncertain_down_is_not_replayed_and_cleanup_is_reverse_and_scoped() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    let b = host
        .open(target(1), "process".into(), "second".into())
        .unwrap();
    host.submit(b, &target(1), 1, &down("C")).unwrap();
    host.submit(a, &target(1), 1, &down("A")).unwrap();
    state.borrow_mut().fail = Some(("B".into(), true, true));
    assert!(matches!(
        host.submit(a, &target(1), 2, &down("B")),
        Err(InputFailure::Post {
            failure: PostFailure::Uncertain(_),
            ..
        })
    ));
    assert!(host.submit(a, &target(1), 2, &down("B")).is_err());
    assert_eq!(host.held_count(b), Ok(1));
    assert_eq!(
        state
            .borrow()
            .events
            .iter()
            .map(|(_, p)| (p.key.as_str(), p.down))
            .collect::<Vec<_>>(),
        [
            ("C", true),
            ("A", true),
            ("B", true),
            ("B", false),
            ("A", false)
        ]
    );
}
#[test]
fn definitely_unsent_down_does_not_generate_stray_up() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    state.borrow_mut().fail = Some(("B".into(), true, false));
    assert!(host.submit(a, &target(1), 1, &down("B")).is_err());
    assert!(state.borrow().events.is_empty());
}
#[test]
fn failed_cleanup_does_not_skip_other_held_releases() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    host.submit(a, &target(1), 1, &down("A")).unwrap();
    host.submit(a, &target(1), 2, &down("B")).unwrap();
    state.borrow_mut().fail = Some(("B".into(), false, true));
    let failures = host.close(a);
    assert_eq!(failures.len(), 1);
    assert_eq!(state.borrow().events.last().unwrap().1.key, "A");
    assert!(host.close(a).is_empty());
}
#[test]
fn backend_panic_releases_only_its_participant_and_rethrows() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    host.submit(a, &target(1), 1, &down("A")).unwrap();
    state.borrow_mut().panic = Some(("B".into(), true));
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| host.submit(
            a,
            &target(1),
            2,
            &down("B")
        )))
        .is_err()
    );
    assert_eq!(
        state
            .borrow()
            .events
            .iter()
            .map(|(_, p)| (p.key.as_str(), p.down))
            .collect::<Vec<_>>(),
        [("A", true), ("B", false), ("A", false)]
    );
}
#[test]
fn cleanup_panic_is_reported_and_remaining_releases_are_attempted() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    host.submit(a, &target(1), 1, &down("A")).unwrap();
    host.submit(a, &target(1), 2, &down("B")).unwrap();
    state.borrow_mut().panic = Some(("B".into(), false));
    assert!(matches!(
        host.close(a).as_slice(),
        [PostFailure::BackendPanicked]
    ));
    assert_eq!(state.borrow().events.last().unwrap().1.key, "A");
}

#[test]
fn preparation_failure_keeps_existing_holds_and_consumes_sequence() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    host.submit(a, &target(1), 1, &down("A")).unwrap();
    assert!(matches!(
        host.submit(a, &target(1), 2, &down("unsupported")),
        Err(InputFailure::Prepare(_))
    ));
    assert_eq!(host.held_count(a), Ok(1));
    assert!(host.submit(a, &target(1), 2, &up("A")).is_err());
    assert_eq!(state.borrow().events.len(), 1);
    host.close(a);
}
#[test]
fn movement_failure_releases_last_delivered_point_only_when_definitely_unsent() {
    for uncertain in [false, true] {
        let (mut host, state) = fixture();
        let a = host
            .open(target(1), "process".into(), "first".into())
            .unwrap();
        let packet = |key: &str, down| Packet {
            key: key.into(),
            down,
            modifiers: vec![],
        };
        host.submit_prepared(
            a,
            &target(1),
            1,
            Prepared::Down {
                control: "pointer".into(),
                packet: packet("start", true),
                release: packet("start", false),
            },
        )
        .unwrap();
        state.borrow_mut().fail = Some(("end".into(), true, uncertain));
        assert!(
            host.submit_prepared(
                a,
                &target(1),
                2,
                Prepared::MoveHeld {
                    control: "pointer".into(),
                    packet: packet("end", true),
                    release: packet("end", false)
                }
            )
            .is_err()
        );
        let last = state.borrow().events.last().unwrap().1.clone();
        assert_eq!(last.key, if uncertain { "end" } else { "start" });
        assert!(!last.down);
    }
}
#[test]
fn uncertain_up_is_never_replayed_but_unsent_up_gets_one_cleanup_attempt() {
    for uncertain in [false, true] {
        let (mut host, state) = fixture();
        let a = host
            .open(target(1), "process".into(), "first".into())
            .unwrap();
        host.submit(a, &target(1), 1, &down("A")).unwrap();
        state.borrow_mut().fail = Some(("A".into(), false, uncertain));
        assert!(host.submit(a, &target(1), 2, &up("A")).is_err());
        assert_eq!(state.borrow().events.len(), 2);
        assert!(!state.borrow().events[1].1.down);
        assert!(host.close(a).is_empty());
    }
}
#[test]
fn transient_pointer_action_cannot_interfere_with_another_drag() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    let b = host
        .open(target(1), "process".into(), "second".into())
        .unwrap();
    host.submit(a, &target(1), 1, &down("pointer")).unwrap();
    let packet = Packet {
        key: "move".into(),
        down: true,
        modifiers: vec![],
    };
    assert!(matches!(
        host.submit_prepared(
            b,
            &target(1),
            1,
            Prepared::Action {
                controls: vec!["POINTER".into()],
                packet
            }
        ),
        Err(InputFailure::Ownership(OwnershipError::Conflict))
    ));
    assert_eq!(state.borrow().events.len(), 1);
    assert_eq!(host.held_count(a), Ok(1));
}

#[test]
fn refreshing_delivery_context_preserves_holds_and_rejects_target_rebinding() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "before".into())
        .unwrap();
    host.submit(a, &target(1), 1, &down("A")).unwrap();
    assert_eq!(
        host.update_destination(a, &target(2), "wrong".into()),
        Err(OwnershipError::StaleInput)
    );
    host.update_destination(a, &target(1), "after".into())
        .unwrap();
    assert_eq!(host.held_count(a), Ok(1));
    host.submit(a, &target(1), 2, &up("A")).unwrap();
    assert_eq!(
        state
            .borrow()
            .events
            .iter()
            .map(|(t, _)| t.as_str())
            .collect::<Vec<_>>(),
        ["before", "after"]
    );
    assert_eq!(state.borrow().events[1].1.modifiers, [Modifier::Meta]);
}
#[test]
fn precompilation_has_no_input_side_effect_and_uses_the_live_participants_context() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    let prepared = host.prepare(a, &down("A")).unwrap();
    assert!(state.borrow().events.is_empty());
    assert_eq!(host.held_count(a), Ok(0));
    host.submit_prepared(a, &target(1), 1, prepared).unwrap();
    host.close(a);
    assert_eq!(state.borrow().events.len(), 2);
    assert!(host.prepare(a, &down("B")).is_err());
}

#[test]
fn backend_resources_close_once_after_release_even_on_delivery_failure() {
    let (mut host, state) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    let b = host
        .open(target(1), "process".into(), "second".into())
        .unwrap();
    host.submit(a, &target(1), 1, &down("A")).unwrap();
    state.borrow_mut().fail = Some(("B".into(), true, true));
    assert!(host.submit(a, &target(1), 2, &down("B")).is_err());
    assert_eq!(state.borrow().closed, ["first"]);
    host.close(a);
    assert_eq!(state.borrow().closed, ["first"]);
    host.close(b);
    assert_eq!(state.borrow().closed, ["first", "second"]);
}

#[test]
fn semantic_actions_share_collision_domains_and_keep_native_results() {
    use std::cell::Cell;
    let (mut host, _) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    let b = host
        .open(target(1), "process".into(), "second".into())
        .unwrap();
    let c = host
        .open(target(1), "independent".into(), "third".into())
        .unwrap();
    host.submit(a, &target(1), 1, &down("A")).unwrap();
    let calls = Cell::new(0);
    assert!(matches!(
        host.submit_action(b, &target(1), 1, &["A".into()], |_, _| {
            calls.set(calls.get() + 1);
            Ok(())
        }),
        Err(InputFailure::Ownership(OwnershipError::Conflict))
    ));
    assert_eq!(calls.get(), 0);
    assert_eq!(host.held_count(a), Ok(1));
    assert_eq!(host.held_count(b), Ok(0));
    let value = host
        .submit_action(c, &target(1), 1, &["A".into()], |_, destination| {
            assert_eq!(destination, "third");
            Ok(("dispatched-unverified", 42))
        })
        .unwrap();
    assert_eq!(value, ("dispatched-unverified", 42));
    // Semantic activation need not claim physical controls it never touches.
    host.submit_action(b, &target(1), 2, &[], |_, _| Ok(()))
        .unwrap();
    host.submit(a, &target(1), 2, &up("A")).unwrap();
    host.submit_action(b, &target(1), 3, &["A".into()], |_, _| Ok(()))
        .unwrap();
}

#[test]
fn semantic_actions_fence_replay_and_stale_target_before_callback() {
    let (mut host, _) = fixture();
    let a = host
        .open(target(1), "process".into(), "first".into())
        .unwrap();
    host.submit_action(a, &target(1), 1, &[], |_, _| Ok(()))
        .unwrap();
    host.submit(a, &target(1), 2, &down("A")).unwrap();
    assert!(matches!(
        host.submit_action::<()>(a, &target(1), 1, &[], |_, _| panic!("replayed")),
        Err(InputFailure::Ownership(_))
    ));
    assert!(matches!(
        host.submit_action::<()>(a, &target(2), 3, &[], |_, _| panic!("stale target")),
        Err(InputFailure::Ownership(OwnershipError::StaleInput))
    ));
    assert_eq!(host.held_count(a), Ok(1));
    host.close(a);
    assert!(matches!(
        host.submit_action::<()>(a, &target(1), 3, &[], |_, _| panic!("closed")),
        Err(InputFailure::Ownership(OwnershipError::SessionNotFound))
    ));
}

#[test]
fn semantic_action_failures_and_panics_release_only_their_participant() {
    for panic in [false, true] {
        let (mut host, state) = fixture();
        let a = host
            .open(target(1), "process".into(), "first".into())
            .unwrap();
        let b = host
            .open(target(1), "process".into(), "second".into())
            .unwrap();
        host.submit(a, &target(1), 1, &down("A")).unwrap();
        host.submit(a, &target(1), 2, &down("B")).unwrap();
        host.submit(b, &target(1), 1, &down("C")).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            host.submit_action::<()>(a, &target(1), 3, &[], |_, _| {
                if panic {
                    panic!("native action panic");
                }
                Err(PostFailure::Uncertain("action may have run"))
            })
        }));
        if panic {
            assert!(result.is_err());
        } else {
            assert!(matches!(
                result.unwrap(),
                Err(InputFailure::Post {
                    failure: PostFailure::Uncertain(_),
                    ..
                })
            ));
        }
        assert_eq!(host.held_count(a), Err(OwnershipError::SessionNotFound));
        assert_eq!(host.held_count(b), Ok(1));
        assert!(host.close(a).is_empty());
        let state = state.borrow();
        assert_eq!(
            state
                .events
                .iter()
                .filter(|(_, p)| !p.down)
                .map(|(_, p)| p.key.as_str())
                .collect::<Vec<_>>(),
            ["B", "A"]
        );
        assert_eq!(state.closed, ["first"]);
    }
}
