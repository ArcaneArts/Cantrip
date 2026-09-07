use cantrip_cua::{
    cursor::CursorState,
    effects::{
        Configuration, DESCRIPTORS, EffectId, MAX_CURSORS, MAX_EVENTS,
        telemetry::{EventKind, InputEvent, Telemetry},
        uniforms::{CursorUniform, EventUniform, FrameTiming, FrameUniform},
    },
    service::{SessionBinding, SessionState},
    target::{Bounds, Point, Target, TargetKind},
};

fn session(id: &str) -> SessionState {
    SessionState {
        binding: SessionBinding {
            session_id: id.into(),
            worker_id: "worker".into(),
            chat_id: id.into(),
            thread_id: Some(id.into()),
            task_id: None,
            turn_id: None,
        },
        target: Some(Target {
            id: "window".into(),
            generation: 1,
            kind: TargetKind::Window,
            title: None,
            application: None,
            process_id: Some(42),
            bounds: Bounds {
                x: -400.0,
                y: 50.0,
                width: 800.0,
                height: 600.0,
            },
            pixel_width: 1600,
            pixel_height: 1200,
            scale_factor: 2.0,
            focused: None,
            minimized: None,
        }),
        cursor: CursorState::new(),
        observation_revision: 1,
    }
}
fn event(kind: EventKind, code: u32, modifiers: u32) -> InputEvent {
    InputEvent {
        kind,
        code,
        modifiers,
        position: Some(Point { x: 200.0, y: 300.0 }),
        delta: [0.0; 2],
    }
}
fn moving(step_ns: u64) -> (Telemetry, SessionState) {
    let state = session("agent");
    let mut telemetry = Telemetry::default();
    telemetry.synchronize(std::slice::from_ref(&state), 0);
    for time in (step_ns..=300_000_000).step_by(step_ns as usize) {
        telemetry.movement(
            "agent",
            state.target.as_ref().unwrap(),
            Point {
                x: time as f64 / 1e6,
                y: 0.0,
            },
            time,
            false,
        );
        // Any number of rendering samples must not feed back into integration.
        for _ in 0..3 {
            telemetry.window("window", 1, time + 1);
        }
    }
    (telemetry, state)
}
#[test]
fn velocity_smoothing_is_independent_of_sample_and_movement_rate() {
    let (fast, _) = moving(10_000_000);
    let (slow, _) = moving(20_000_000);
    let a = fast.window("window", 1, 300_000_000).remove(0);
    let b = slow.window("window", 1, 300_000_000).remove(0);
    assert_eq!(a.raw_velocity, [1000.0, 0.0]);
    assert!((a.smoothed_velocity[0] - b.smoothed_velocity[0]).abs() < 1e-8);
    assert!((a.smoothed_velocity[0] - 1000.0 * (1.0 - (-5_f64).exp())).abs() < 1e-8);
    let idle = fast.window("window", 1, 700_000_000).remove(0);
    assert!(idle.smoothed_velocity[0] < 7.0);
    assert_eq!(idle.position, a.position);
    assert_eq!(
        fast.window("window", 1, 300_000_000)[0].raw_velocity,
        a.raw_velocity
    );
}
#[test]
fn geometry_changes_reset_motion_but_window_translation_does_not() {
    let (mut telemetry, mut state) = moving(10_000_000);
    // Bring the service cursor up to the last actual presentation position.
    state.cursor.position.x = 300.0;
    state.target.as_mut().unwrap().bounds.x += 700.0;
    telemetry.synchronize(&[state.clone()], 300_000_000);
    assert_eq!(
        telemetry.window("window", 1, 300_000_000)[0].raw_velocity[0],
        1000.0
    );
    state.target.as_mut().unwrap().bounds.width = 900.0;
    telemetry.synchronize(&[state.clone()], 300_000_000);
    assert_eq!(
        telemetry.window("window", 1, 300_000_000)[0].raw_velocity,
        [0.0; 2]
    );
    telemetry.movement(
        "agent",
        state.target.as_ref().unwrap(),
        Point { x: 310.0, y: 0.0 },
        310_000_000,
        false,
    );
    state.cursor.position.x = 310.0;
    state.target.as_mut().unwrap().scale_factor = 1.0;
    telemetry.synchronize(&[state], 310_000_000);
    assert_eq!(
        telemetry.window("window", 1, 310_000_000)[0].smoothed_velocity,
        [0.0; 2]
    );
}
#[test]
fn input_records_events_without_advancing_the_presented_cursor() {
    let mut telemetry = Telemetry::default();
    let state = session("agent");
    let target = state.target.as_ref().unwrap();
    telemetry.synchronize(&[state.clone()], 0);
    telemetry.input("agent", target, event(EventKind::Press, 4, 8), 10);
    telemetry.input("agent", target, event(EventKind::KeyDown, 8, 1), 11);
    let a = telemetry.window("window", 1, 11).remove(0);
    assert_eq!(a.position, Point::default());
    assert_eq!(a.buttons(), 16);
    assert_eq!(a.modifiers(), 9);
    assert_eq!(a.last_press_ns, Some(10));
    telemetry.input("agent", target, event(EventKind::Release, 4, 8), 12);
    assert_eq!(telemetry.window("window", 1, 12)[0].modifiers(), 1);
    telemetry.input("agent", target, event(EventKind::KeyUp, 8, 1), 13);
    let a = telemetry.window("window", 1, 13).remove(0);
    assert_eq!(a.buttons(), 0);
    assert_eq!(a.modifiers(), 0);
    assert_eq!(a.last_release_ns, Some(12));
    assert_eq!(a.sequence, 4);
}
#[test]
fn detach_and_new_generation_clear_held_input_and_ignore_late_callbacks() {
    let mut telemetry = Telemetry::default();
    let mut state = session("agent");
    let old = state.target.clone().unwrap();
    telemetry.synchronize(&[state.clone()], 0);
    telemetry.input("agent", &old, event(EventKind::Press, 0, 8), 1);
    state.target.as_mut().unwrap().generation = 2;
    telemetry.synchronize(&[state], 2);
    telemetry.input("agent", &old, event(EventKind::Release, 0, 8), 3);
    assert!(telemetry.window("window", 1, 3).is_empty());
    let a = telemetry.window("window", 2, 3).remove(0);
    assert_eq!(a.buttons(), 0);
    assert_eq!(a.sequence, 0);
    telemetry.synchronize(&[], 4);
    telemetry.input("agent", &old, event(EventKind::Press, 0, 0), 5);
    assert!(telemetry.window("window", 2, 5).is_empty());
}
#[test]
fn discontinuities_and_nonfinite_samples_do_not_create_velocity_spikes() {
    let (mut telemetry, state) = moving(10_000_000);
    let target = state.target.as_ref().unwrap();
    telemetry.movement(
        "agent",
        target,
        Point {
            x: f64::NAN,
            y: 0.0,
        },
        310_000_000,
        false,
    );
    telemetry.movement("agent", target, Point { x: 10.0, y: 0.0 }, 1, false);
    assert_eq!(
        telemetry.window("window", 1, 300_000_000)[0].position.x,
        300.0
    );
    telemetry.movement(
        "agent",
        target,
        Point { x: 500.0, y: 0.0 },
        310_000_000,
        true,
    );
    assert_eq!(
        telemetry.window("window", 1, 310_000_000)[0].raw_velocity,
        [0.0; 2]
    );
    telemetry.movement(
        "agent",
        target,
        Point { x: 600.0, y: 0.0 },
        1_000_000_000,
        false,
    );
    assert_eq!(
        telemetry.window("window", 1, 1_000_000_000)[0].raw_velocity,
        [0.0; 2]
    );
}
#[test]
fn events_are_bounded_and_expire_without_changing_last_click_time() {
    let mut telemetry = Telemetry::default();
    let state = session("agent");
    let target = state.target.as_ref().unwrap();
    telemetry.synchronize(&[state.clone()], 0);
    for n in 0..100 {
        telemetry.input("agent", target, event(EventKind::ControlAction, 0, 0), n);
    }
    let a = telemetry.window("window", 1, 100).remove(0);
    assert_eq!(a.events.len(), 32);
    assert_eq!(a.events[0].sequence, 69);
    assert_eq!(a.last_press_ns, Some(99));
    assert_eq!(a.last_release_ns, Some(99));
    let a = telemetry.window("window", 1, 3_000_000_000).remove(0);
    assert!(a.events.is_empty());
    assert_eq!(a.last_press_ns, Some(99));
}
#[test]
fn shared_window_agents_keep_deterministic_identity_color_and_order() {
    let a = session("a");
    let mut b = session("b");
    b.cursor.appearance.color = "#FA8040D0".into();
    let mut telemetry = Telemetry::default();
    telemetry.synchronize(&[b.clone(), a.clone()], 0);
    let first = telemetry.window("window", 1, 0);
    telemetry.synchronize(&[a, b], 1);
    let second = telemetry.window("window", 1, 1);
    assert_eq!(first.len(), 2);
    assert_ne!(first[0].identity, first[1].identity);
    assert_eq!(
        first.iter().map(|a| a.identity).collect::<Vec<_>>(),
        second.iter().map(|a| a.identity).collect::<Vec<_>>()
    );
    assert!(
        second
            .iter()
            .any(|a| a.color == [250., 128., 64., 208.].map(|v| v / 255.))
    );
}
#[test]
fn shader_frame_preserves_precision_coordinates_flags_and_event_order() {
    let mut telemetry = Telemetry::default();
    let state = session("agent");
    let target = state.target.as_ref().unwrap();
    let epoch = 8_000_000_000_000_000;
    telemetry.synchronize(&[state.clone()], epoch);
    telemetry.movement(
        "agent",
        target,
        Point { x: 200., y: 300. },
        epoch + 10_000_000,
        true,
    );
    telemetry.input(
        "agent",
        target,
        event(EventKind::Press, 2, 8),
        epoch + 20_000_000,
    );
    let frame = FrameUniform::new(
        FrameTiming {
            epoch_ns: epoch,
            now_ns: epoch + 50_000_000,
            previous_ns: epoch + 40_000_000,
            source_ns: epoch + 30_000_000,
            frame: 4,
        },
        [800., 600.],
        [1600, 1200],
        &Configuration::default(),
        &telemetry.window("window", 1, epoch + 50_000_000),
    );
    assert_eq!(frame.header, [1, 1, 1, 4]);
    assert_eq!(frame.time, [0.05, 0.01, 0.03, 0.02]);
    assert_eq!(frame.window, [800., 600., 2., 2.]);
    assert_eq!(frame.cursors[0].position, [200., 300., 0.25, 0.5]);
    assert_eq!(frame.cursors[0].state[1..3], [4, 8]);
    assert_eq!(frame.cursors[0].click_time, [0.02, -1., 0.03, -1.]);
    assert_eq!(frame.events[0].event, [1, 2, 8, 1]);
    assert_eq!(frame.events[0].sequence, [1, 0, 0, 0]);
    assert_eq!(frame.bytes().len(), 7040);
    assert_eq!(std::mem::offset_of!(FrameUniform, cursors), 128);
    assert_eq!(
        std::mem::offset_of!(FrameUniform, events),
        128 + MAX_CURSORS * std::mem::size_of::<CursorUniform>()
    );
    assert_eq!(std::mem::size_of::<EventUniform>(), 80);
    assert_eq!(std::mem::align_of::<FrameUniform>(), 16);
}
#[test]
fn shader_frame_retains_the_latest_events_across_agents() {
    let mut telemetry = Telemetry::default();
    let states: Vec<_> = (0..3).map(|i| session(&i.to_string())).collect();
    telemetry.synchronize(&states, 0);
    for n in 0..96 {
        let s = &states[n % 3];
        telemetry.input(
            &s.binding.session_id,
            s.target.as_ref().unwrap(),
            event(EventKind::ControlAction, 0, 0),
            n as u64 * 1_000_000,
        );
    }
    let frame = FrameUniform::new(
        FrameTiming {
            epoch_ns: 0,
            now_ns: 100_000_000,
            previous_ns: 0,
            source_ns: 0,
            frame: 0,
        },
        [800., 600.],
        [1600, 1200],
        &Configuration::default(),
        &telemetry.window("window", 1, 100_000_000),
    );
    assert_eq!(frame.header[2], MAX_EVENTS as u32);
    assert_eq!(frame.events[0].timing[0], 0.032);
    assert_eq!(frame.events[63].timing[0], 0.095);
}
#[test]
fn effect_parameters_have_defaults_and_reject_invalid_values() {
    assert_eq!(Configuration::default().effect, EffectId::Off);
    for descriptor in DESCRIPTORS {
        let mut config = Configuration {
            effect: descriptor.id,
            ..Configuration::default()
        };
        config.validate().unwrap();
        for p in descriptor.parameters {
            assert_eq!(config.value(p.id), p.default);
            for value in [f32::NAN, f32::INFINITY, p.max + 1., p.min - 1.] {
                config.parameters.insert(p.id.into(), value);
                assert!(config.validate().is_err());
            }
            config.parameters.insert(p.id.into(), p.default);
        }
        config.parameters.insert("typo".into(), 1.);
        assert!(config.validate().is_err());
    }
    let mut config = Configuration {
        effect: EffectId::DebugGradient,
        ..Configuration::default()
    };
    config.parameters.insert("showTelemetry".into(), 0.5);
    assert!(config.validate().is_err());
}
