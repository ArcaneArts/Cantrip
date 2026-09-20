use cantrip_interaction::{
    geometry::Point,
    input::{InputEvent, InputScope, MediaKey, Modifier, TextInput},
    ownership::{Ownership, OwnershipError, TargetIdentity},
    schedule::{self, Frame, Transition},
};
use std::{
    cell::{Cell, RefCell},
    time::Duration,
};
fn target(generation: u64) -> TargetIdentity {
    TargetIdentity {
        id: "surface".into(),
        generation,
    }
}
#[test]
fn independent_holds_persist_until_their_owners_release_or_close() {
    let mut owners = Ownership::new(4, 16);
    let a = owners.open(target(1), "application".into()).unwrap();
    let b = owners.open(target(1), "application".into()).unwrap();
    owners.hold(a, "C", ("C up", vec![Modifier::Meta])).unwrap();
    owners.hold(b, "E", ("E up", vec![])).unwrap();
    assert_eq!(owners.held(a, &"C").unwrap().1, vec![Modifier::Meta]);
    assert_eq!(
        owners.hold(b, "C", ("C up", vec![])),
        Err(OwnershipError::Conflict)
    );
    assert_eq!(owners.release(b, &"C"), Err(OwnershipError::NotHeld));
    assert_eq!(owners.held_count(a), Ok(1));
    assert_eq!(owners.close(b), vec![("E up", vec![])]);
    assert!(owners.close(b).is_empty());
    assert_eq!(
        owners.release(a, &"C").unwrap(),
        ("C up", vec![Modifier::Meta])
    );
    assert_eq!(owners.release(a, &"C"), Err(OwnershipError::NotHeld));
    assert!(owners.close(a).is_empty());
    assert_eq!(owners.participants().count(), 0);
}
#[test]
fn cleanup_uses_last_drag_position_and_reverse_acquisition_order() {
    let mut owners = Ownership::new(2, 16);
    let a = owners.open(target(1), "one".into()).unwrap();
    owners.hold(a, "pointer", Point { x: 1., y: 2. }).unwrap();
    owners.hold(a, "key", Point { x: 0., y: 0. }).unwrap();
    owners
        .update_release(a, &"pointer", Point { x: 200., y: 300. })
        .unwrap();
    assert_eq!(
        owners.close(a),
        vec![Point { x: 0., y: 0. }, Point { x: 200., y: 300. }]
    );
}
#[test]
fn old_session_tokens_cannot_access_reopened_targets_or_consume_capacity() {
    let mut owners = Ownership::new(1, 1);
    let old = owners.open(target(1), "app".into()).unwrap();
    owners.hold(old, "A", "up A").unwrap();
    assert_eq!(
        owners.hold(old, "A", "up A"),
        Err(OwnershipError::AlreadyHeld)
    );
    assert_eq!(owners.hold(old, "B", "up B"), Err(OwnershipError::Capacity));
    assert_eq!(
        owners.open(target(2), "app".into()),
        Err(OwnershipError::Capacity)
    );
    assert_eq!(owners.close(old), vec!["up A"]);
    let new = owners.open(target(2), "app".into()).unwrap();
    assert_ne!(old, new);
    assert_eq!(owners.target(new), Ok(&target(2)));
    assert_eq!(
        owners.hold(old, "A", "old release"),
        Err(OwnershipError::SessionNotFound)
    );
    owners.hold(new, "A", "new release").unwrap();
    assert!(owners.close(old).is_empty());
    assert_eq!(owners.close(new), vec!["new release"]);
}
#[test]
fn collision_domain_matches_backend_shared_state_not_only_window_id() {
    let mut owners = Ownership::new(3, 16);
    let a = owners.open(target(1), "pid:10".into()).unwrap();
    let b = owners
        .open(
            TargetIdentity {
                id: "other-window".into(),
                generation: 1,
            },
            "pid:10".into(),
        )
        .unwrap();
    let c = owners.open(target(1), "pid:20".into()).unwrap();
    owners.hold(a, "A", ()).unwrap();
    assert_eq!(owners.hold(b, "A", ()), Err(OwnershipError::Conflict));
    owners.hold(c, "A", ()).unwrap();
    assert_eq!(owners.close(a), vec![()]);
    owners.hold(b, "A", ()).unwrap();
    assert_eq!(owners.held_count(c), Ok(1));
}
#[test]
fn structural_validation_distinguishes_text_physical_keys_and_side_effect_scope() {
    let key = InputEvent::KeyDown {
        key: "BrowserSpecificKey".into(),
        modifiers: vec![Modifier::Meta],
        repeat: false,
    };
    key.validate().unwrap(); // support is determined by the actual backend
    assert_eq!(key.scope(), InputScope::Surface);
    assert_eq!(InputEvent::PrepareSurface.scope(), InputScope::Surface);
    assert_eq!(InputEvent::RequestHostFocus.scope(), InputScope::HostFocus);
    assert_eq!(
        InputEvent::Media {
            key: MediaKey::PlayPause,
            modifiers: vec![]
        }
        .scope(),
        InputScope::System
    );
    InputEvent::Text(TextInput::Composition {
        text: "🎹".into(),
        selection_start: 0,
        selection_end: 2,
    })
    .validate()
    .unwrap();
    assert!(
        InputEvent::Text(TextInput::Composition {
            text: "🎹".into(),
            selection_start: 0,
            selection_end: 3
        })
        .validate()
        .is_err()
    );
    assert!(
        InputEvent::KeyDown {
            key: "K".into(),
            modifiers: vec![Modifier::Meta, Modifier::Meta],
            repeat: false
        }
        .validate()
        .is_err()
    );
    assert!(
        InputEvent::PointerMove {
            point: Point { x: f64::NAN, y: 0. },
            modifiers: vec![]
        }
        .validate()
        .is_err()
    );
}
#[test]
fn shared_dispatch_releases_only_started_events_when_cancelled() {
    let frames = vec![
        Frame {
            at: Duration::ZERO,
            events: vec![Transition::Down(0), Transition::Down(1)],
        },
        Frame {
            at: Duration::from_secs(150),
            events: vec![Transition::Up(0), Transition::Up(1)],
        },
    ];
    let posted = RefCell::new(vec![]);
    let cancelled = Cell::new(false);
    let failure = schedule::dispatch(
        frames,
        2,
        || {
            if cancelled.get() {
                Err("cancelled")
            } else {
                Ok(())
            }
        },
        |event| posted.borrow_mut().push(event),
        |_| Ok(()),
        |at| {
            if at > Duration::ZERO {
                cancelled.set(true);
            }
            Ok(at)
        },
    )
    .unwrap_err();
    assert!(failure.input_began);
    assert_eq!(failure.source, "cancelled");
    assert_eq!(
        *posted.borrow(),
        vec![
            Transition::Down(0),
            Transition::Down(1),
            Transition::Up(1),
            Transition::Up(0)
        ]
    );
}
#[test]
fn preparation_failure_posts_nothing_and_preserves_its_error() {
    let posted = RefCell::new(vec![]);
    let failure = schedule::dispatch(
        vec![Frame {
            at: Duration::ZERO,
            events: vec![Transition::Down(0)],
        }],
        1,
        || Ok(()),
        |e| posted.borrow_mut().push(e),
        |_| Err("unsupported"),
        Ok,
    )
    .unwrap_err();
    assert!(!failure.input_began);
    assert_eq!(failure.source, "unsupported");
    assert!(posted.borrow().is_empty());
}

#[test]
fn tokens_from_another_registry_are_not_authority_for_this_one() {
    let mut one = Ownership::new(1, 1);
    let mut two = Ownership::new(1, 1);
    let a = one.open(target(1), "app".into()).unwrap();
    let b = two.open(target(1), "app".into()).unwrap();
    one.hold(a, "A", ()).unwrap();
    two.hold(b, "B", ()).unwrap();
    assert_ne!(a, b);
    assert_eq!(two.hold(a, "A", ()), Err(OwnershipError::SessionNotFound));
    assert!(two.close(a).is_empty());
    assert_eq!(two.held_count(b), Ok(1));
}

#[test]
fn sequences_reject_duplicates_and_reordering_without_touching_held_input() {
    let mut owners = Ownership::new(2, 4);
    let a = owners.open(target(1), "app".into()).unwrap();
    let b = owners.open(target(1), "app".into()).unwrap();
    owners.accept_sequence(a, 100).unwrap();
    owners.hold(a, "A", "release").unwrap();
    assert_eq!(
        owners.accept_sequence(a, 100),
        Err(OwnershipError::StaleInput)
    );
    assert_eq!(
        owners.accept_sequence(a, 99),
        Err(OwnershipError::StaleInput)
    );
    assert_eq!(owners.held_count(a), Ok(1));
    owners.accept_sequence(b, 0).unwrap();
    owners.accept_sequence(a, 101).unwrap();
    assert_eq!(owners.close(a), vec!["release"]);
    let replacement = owners.open(target(2), "app".into()).unwrap();
    owners.accept_sequence(replacement, 0).unwrap();
    assert_eq!(
        owners.accept_sequence(a, 102),
        Err(OwnershipError::SessionNotFound)
    );
}
