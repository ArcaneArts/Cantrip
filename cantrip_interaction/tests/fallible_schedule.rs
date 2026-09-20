use cantrip_interaction::schedule::{Frame, Transition, dispatch_fallible};
use std::{cell::RefCell, time::Duration};
#[test]
fn delivery_failure_stops_sequence_and_attempts_each_outstanding_release() {
    let events = RefCell::new(vec![]);
    let frames = [Frame {
        at: Duration::ZERO,
        events: vec![
            Transition::Down(0),
            Transition::Down(1),
            Transition::Down(2),
        ],
    }];
    let error = dispatch_fallible(
        &frames,
        3,
        || Ok(()),
        |event| {
            events.borrow_mut().push(event);
            match event {
                Transition::Down(1) => Err("down failed"),
                Transition::Up(1) => Err("cleanup failed"),
                _ => Ok(()),
            }
        },
        |_| Ok(()),
        Ok,
    )
    .unwrap_err();
    assert!(error.input_began);
    assert_eq!(error.source, "down failed");
    assert_eq!(
        *events.borrow(),
        [
            Transition::Down(0),
            Transition::Down(1),
            Transition::Up(1),
            Transition::Up(0)
        ]
    );
}
#[test]
fn cleanup_failure_is_not_lost_on_otherwise_successful_sequence() {
    let error = dispatch_fallible(
        [Frame {
            at: Duration::ZERO,
            events: vec![Transition::Down(0)],
        }],
        1,
        || Ok(()),
        |event| {
            if event == Transition::Up(0) {
                Err("up failed")
            } else {
                Ok(())
            }
        },
        |_| Ok(()),
        Ok,
    )
    .unwrap_err();
    assert_eq!(error.source, "up failed");
    assert!(error.input_began);
}
