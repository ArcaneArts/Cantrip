use cantrip_cua::{
    backend::{Capture, CaptureBackend, FakeBackend, Raster, UnavailableBackend},
    cancellation::Cancellation,
    cursor::{CursorAppearance, CursorStyle},
    error::{CuaError, ErrorCode, Result},
    service::{CuaService, MAX_SESSIONS, Operation, OperationResult, SessionBinding, SessionState},
    target::{Point, Target},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Cursor,
    sync::{Arc, Mutex},
};

fn binding() -> SessionBinding {
    SessionBinding {
        session_id: "session-1".into(),
        worker_id: "worker-1".into(),
        chat_id: "chat-1".into(),
        task_id: Some("task-1".into()),
        thread_id: Some("thread-1".into()),
        turn_id: Some("turn-1".into()),
    }
}

fn attach(binding: &SessionBinding, target: &str, generation: u64) -> Operation {
    Operation::TargetAttach {
        binding: binding.clone(),
        target_id: target.into(),
        target_generation: generation,
    }
}

fn snapshot(binding: &SessionBinding, generation: u64) -> Operation {
    Operation::Snapshot {
        binding: binding.clone(),
        target_id: "fake-window".into(),
        target_generation: generation,
    }
}

fn apply<B: CaptureBackend>(service: &mut CuaService<B>, operation: Operation) -> OperationResult {
    service
        .execute(operation, &Cancellation::default(), 100)
        .expect("operation succeeds")
}

fn state(result: &OperationResult) -> SessionState {
    serde_json::from_value(result.data["session"].clone()).expect("session result")
}

fn error_code<B: CaptureBackend>(service: &mut CuaService<B>, operation: Operation) -> ErrorCode {
    service
        .execute(operation, &Cancellation::default(), 100)
        .err()
        .expect("operation fails")
        .code
}

fn configure<B: CaptureBackend>(
    service: &mut CuaService<B>,
    binding: &SessionBinding,
) -> CursorAppearance {
    configure_target(service, binding, "fake-window")
}

fn configure_target<B: CaptureBackend>(
    service: &mut CuaService<B>,
    binding: &SessionBinding,
    target_id: &str,
) -> CursorAppearance {
    let appearance = CursorAppearance {
        style: CursorStyle::Ring,
        color: "#FA8040D0".into(),
        size: 16,
        label: Some("Agent".into()),
        trail: true,
        ..CursorAppearance::default()
    };
    apply(
        service,
        Operation::CursorConfigure {
            binding: binding.clone(),
            target_id: target_id.into(),
            target_generation: 1,
            appearance: appearance.clone(),
        },
    );
    appearance
}

fn move_cursor<B: CaptureBackend>(
    service: &mut CuaService<B>,
    binding: &SessionBinding,
    x: f64,
    y: f64,
) -> SessionState {
    move_cursor_target(service, binding, "fake-window", x, y)
}

fn move_cursor_target<B: CaptureBackend>(
    service: &mut CuaService<B>,
    binding: &SessionBinding,
    target_id: &str,
    x: f64,
    y: f64,
) -> SessionState {
    state(&apply(
        service,
        Operation::CursorMove {
            binding: binding.clone(),
            target_id: target_id.into(),
            target_generation: 1,
            position: Point { x, y },
        },
    ))
}

#[test]
fn fake_monitor_and_window_return_decodable_png_with_matching_digest_and_metadata() {
    let mut service = CuaService::new(FakeBackend);
    let owner = binding();
    let inventory = apply(&mut service, Operation::TargetsList {});
    let targets: Vec<Target> = serde_json::from_value(inventory.data["targets"].clone()).unwrap();
    assert_eq!(targets.len(), 2);
    assert!(
        targets
            .iter()
            .any(|target| target.bounds.x < 0.0 && target.scale_factor == 2.0)
    );

    for (id, width, height, blue) in [
        ("fake-monitor", 640, 360, 90),
        ("fake-window", 320, 200, 130),
    ] {
        apply(&mut service, attach(&owner, id, 1));
        let result = apply(
            &mut service,
            Operation::Snapshot {
                binding: owner.clone(),
                target_id: id.into(),
                target_generation: 1,
            },
        );
        let image = &result.data["image"];
        assert_eq!(image["mediaType"], "image/png");
        assert_eq!(image["width"], width);
        assert_eq!(image["height"], height);
        assert_eq!(image["byteCount"], result.payload.len());
        assert_eq!(
            image["sha256"],
            format!("{:x}", Sha256::digest(&result.payload))
        );
        assert_eq!(image["cursorIncluded"], true);
        assert_eq!(
            result.event,
            Some(("snapshotCompleted", owner.session_id.clone()))
        );
        let decoder = png::Decoder::new(Cursor::new(&result.payload));
        let mut reader = decoder.read_info().expect("valid PNG header");
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut pixels).expect("valid PNG frame");
        assert_eq!((info.width, info.height), (width, height));
        assert_eq!(info.color_type, png::ColorType::Rgba);
        assert_eq!(info.bit_depth, png::BitDepth::Eight);
        // The far corner belongs to the fixture, away from the initial cursor.
        assert_eq!(
            &pixels[info.buffer_size() - 2..info.buffer_size()],
            &[blue, 255]
        );
    }
    assert_eq!(service.session_count(), 1);
}

#[test]
fn unavailable_native_backend_reports_unsupported_without_creating_fake_targets() {
    let mut service = CuaService::new(UnavailableBackend);
    let capabilities = apply(&mut service, Operation::CapabilitiesGet {}).data;
    assert_eq!(capabilities["backend"], "unavailable");
    assert_eq!(capabilities["capture"], false);
    assert_eq!(capabilities["nativeInput"], false);
    assert_eq!(capabilities["javascript"], false);
    assert_eq!(
        error_code(&mut service, Operation::TargetsList {}),
        ErrorCode::Unsupported
    );
    assert_eq!(
        error_code(&mut service, attach(&binding(), "fake-window", 1)),
        ErrorCode::Unsupported
    );
    assert_eq!(service.session_count(), 0);
}

#[test]
fn session_cannot_be_reused_by_a_different_worker_chat_task_thread_or_turn() {
    let mut service = CuaService::new(FakeBackend);
    let owner = binding();
    apply(&mut service, attach(&owner, "fake-window", 1));
    for key in ["workerId", "chatId", "taskId", "threadId", "turnId"] {
        let mut other = serde_json::to_value(&owner).unwrap();
        other[key] = json!("another-context");
        let other: SessionBinding = serde_json::from_value(other).unwrap();
        for operation in [
            attach(&other, "fake-window", 1),
            snapshot(&other, 1),
            Operation::SessionClose {
                binding: other.clone(),
            },
        ] {
            assert_eq!(
                error_code(&mut service, operation),
                ErrorCode::OwnershipMismatch,
                "{key}"
            );
        }
    }
    assert_eq!(
        state(&apply(&mut service, snapshot(&owner, 1))).binding,
        owner
    );
    assert_eq!(service.session_count(), 1);
}

#[test]
fn repeated_attachment_by_another_observer_preserves_shared_cursor_state() {
    let mut service = CuaService::new(FakeBackend);
    let owner = binding();
    apply(&mut service, attach(&owner, "fake-window", 1));
    configure(&mut service, &owner);
    let previous = move_cursor(&mut service, &owner, 40.0, 30.0);
    let attached = state(&apply(&mut service, attach(&owner, "fake-window", 1)));
    assert_eq!(attached.cursor, previous.cursor);
    assert_eq!(attached.target, previous.target);
    assert_eq!(service.session_count(), 1);
}

#[test]
fn switching_targets_resets_cursor_geometry_and_preserves_custom_appearance() {
    let mut service = CuaService::new(FakeBackend);
    let owner = binding();
    apply(&mut service, attach(&owner, "fake-monitor", 1));
    let appearance = configure_target(&mut service, &owner, "fake-monitor");
    assert!(
        !move_cursor_target(&mut service, &owner, "fake-monitor", 250.0, 150.0)
            .cursor
            .trail_points
            .is_empty()
    );
    let switched = state(&apply(&mut service, attach(&owner, "fake-window", 1)));
    assert_eq!(switched.cursor.position, Point::default());
    assert!(switched.cursor.trail_points.is_empty());
    assert_eq!(switched.cursor.appearance, appearance);
    assert_eq!(switched.target.unwrap().id, "fake-window");
}

#[test]
fn cursor_configuration_and_motion_change_the_next_image_and_repeat_capture_is_deterministic() {
    let mut service = CuaService::new(FakeBackend);
    let owner = binding();
    apply(&mut service, attach(&owner, "fake-window", 1));
    let initial = apply(&mut service, snapshot(&owner, 1));
    configure(&mut service, &owner);
    let configured = apply(&mut service, snapshot(&owner, 1));
    assert_ne!(configured.payload, initial.payload);
    move_cursor(&mut service, &owner, 80.0, 60.0);
    let moved = apply(&mut service, snapshot(&owner, 1));
    assert_ne!(moved.payload, configured.payload);
    let repeated = apply(&mut service, snapshot(&owner, 1));
    assert_eq!(repeated.payload, moved.payload);
    assert_eq!(
        state(&repeated).observation_revision,
        state(&moved).observation_revision + 1
    );
}

#[test]
fn old_target_commands_are_rejected_after_switching_to_a_target_with_the_same_generation() {
    let mut service = CuaService::new(FakeBackend);
    let owner = binding();
    apply(&mut service, attach(&owner, "fake-monitor", 1));
    let current = state(&apply(&mut service, attach(&owner, "fake-window", 1)));
    for operation in [
        Operation::Snapshot {
            binding: owner.clone(),
            target_id: "fake-monitor".into(),
            target_generation: 1,
        },
        Operation::CursorMove {
            binding: owner.clone(),
            target_id: "fake-monitor".into(),
            target_generation: 1,
            position: Point { x: 20.0, y: 20.0 },
        },
        Operation::CursorConfigure {
            binding: owner.clone(),
            target_id: "fake-monitor".into(),
            target_generation: 1,
            appearance: CursorAppearance {
                color: "#FF0000".into(),
                ..CursorAppearance::default()
            },
        },
    ] {
        assert_eq!(error_code(&mut service, operation), ErrorCode::StaleTarget);
    }
    let after = state(&apply(&mut service, attach(&owner, "fake-window", 1)));
    assert_eq!(after.cursor, current.cursor);
    assert_eq!(after.target, current.target);
    assert_eq!(after.observation_revision, current.observation_revision);
    assert_eq!(
        state(&apply(&mut service, snapshot(&owner, 1)))
            .target
            .unwrap()
            .id,
        "fake-window"
    );
}

#[test]
fn malformed_and_unknown_operation_fields_are_rejected_by_deserialization() {
    let owner = serde_json::to_value(binding()).unwrap();
    for value in [
        json!({"operation":"capabilities.get", "unexpected":true}),
        json!({"operation":"targets.list", "binding":owner}),
        json!({"operation":"target.attach", "binding":owner, "targetId":"fake-window"}),
        json!({"operation":"target.attach", "binding":owner, "targetId":"fake-window", "targetGeneration":-1}),
        json!({"operation":"cursor.move", "binding":owner, "targetId":"fake-window", "targetGeneration":1, "position":{"x":1,"y":2,"z":3}}),
        json!({"operation":"cursor.move", "binding":owner, "targetId":"fake-window", "targetGeneration":1.5, "position":{"x":1,"y":2}}),
        json!({"operation":"cursor.move", "binding":owner, "targetGeneration":1, "position":{"x":1,"y":2}}),
        json!({"operation":"mouse.click", "binding":owner}),
    ] {
        assert!(
            serde_json::from_value::<Operation>(value.clone()).is_err(),
            "accepted {value}"
        );
    }
    let mut wrong_binding: Value = serde_json::to_value(binding()).unwrap();
    wrong_binding["clientId"] = json!("untrusted");
    assert!(
        serde_json::from_value::<Operation>(
            json!({"operation":"session.close", "binding":wrong_binding})
        )
        .is_err()
    );
}

#[test]
fn missing_session_target_and_stale_generation_never_initialize_replacement_state() {
    let mut service = CuaService::new(FakeBackend);
    let owner = binding();
    assert_eq!(
        error_code(&mut service, snapshot(&owner, 1)),
        ErrorCode::SessionNotFound
    );
    assert_eq!(
        error_code(&mut service, attach(&owner, "missing-window", 1)),
        ErrorCode::TargetNotFound
    );
    assert_eq!(
        error_code(&mut service, attach(&owner, "fake-window", 2)),
        ErrorCode::StaleTarget
    );
    assert_eq!(service.session_count(), 0);
    apply(&mut service, attach(&owner, "fake-window", 1));
    assert_eq!(
        error_code(&mut service, snapshot(&owner, 2)),
        ErrorCode::StaleTarget
    );
    apply(
        &mut service,
        Operation::TargetDetach {
            binding: owner.clone(),
        },
    );
    assert_eq!(
        error_code(&mut service, snapshot(&owner, 1)),
        ErrorCode::TargetNotFound
    );
    assert_eq!(service.session_count(), 1);
}

#[test]
fn session_capacity_is_bounded_and_close_releases_a_slot() {
    let mut service = CuaService::new(FakeBackend);
    let mut owner = binding();
    for index in 0..MAX_SESSIONS {
        owner.session_id = format!("session-{index}");
        apply(&mut service, attach(&owner, "fake-window", 1));
    }
    assert_eq!(service.session_count(), MAX_SESSIONS);
    let mut extra = owner.clone();
    extra.session_id = "extra-session".into();
    assert_eq!(
        error_code(&mut service, attach(&extra, "fake-window", 1)),
        ErrorCode::Capacity
    );
    apply(&mut service, attach(&owner, "fake-window", 1));
    let closed = apply(&mut service, Operation::SessionClose { binding: owner });
    assert_eq!(closed.data["closed"], true);
    assert_eq!(service.session_count(), MAX_SESSIONS - 1);
    apply(&mut service, attach(&extra, "fake-window", 1));
    assert_eq!(service.session_count(), MAX_SESSIONS);
}

#[test]
fn already_cancelled_mutations_and_snapshot_leave_existing_state_unchanged() {
    let mut service = CuaService::new(FakeBackend);
    let owner = binding();
    let before = state(&apply(&mut service, attach(&owner, "fake-window", 1)));
    let cancelled = Cancellation::default();
    cancelled.cancel();
    for operation in [
        attach(&owner, "fake-monitor", 1),
        Operation::TargetDetach {
            binding: owner.clone(),
        },
        Operation::CursorConfigure {
            binding: owner.clone(),
            target_id: "fake-window".into(),
            target_generation: 1,
            appearance: CursorAppearance {
                color: "#FF0000".into(),
                ..CursorAppearance::default()
            },
        },
        Operation::CursorMove {
            binding: owner.clone(),
            target_id: "fake-window".into(),
            target_generation: 1,
            position: Point { x: 20.0, y: 20.0 },
        },
        snapshot(&owner, 1),
        Operation::SessionClose {
            binding: owner.clone(),
        },
    ] {
        let error = service.execute(operation, &cancelled, 200).err().unwrap();
        assert_eq!(error.code, ErrorCode::Cancelled);
        let after = state(&apply(&mut service, attach(&owner, "fake-window", 1)));
        assert_eq!(after.cursor, before.cursor);
        assert_eq!(after.target, before.target);
        assert_eq!(after.observation_revision, before.observation_revision);
    }
}

#[test]
fn fake_capture_honors_cancelled_token_without_returning_pixels() {
    let mut backend = FakeBackend;
    let target = backend.targets(&Cancellation::default()).unwrap().remove(0);
    let cancellation = Cancellation::default();
    cancellation.cancel();
    assert_eq!(
        backend.capture(&target, &cancellation).err().unwrap().code,
        ErrorCode::Cancelled
    );
}

#[derive(Clone)]
struct ControlledBackend(Arc<Mutex<BackendState>>);

struct BackendState {
    target: Option<Target>,
    inventory_truncated: bool,
    invalid_pixels: bool,
    cancel_inventory: bool,
    cancel_capture: bool,
}

impl ControlledBackend {
    fn new() -> Self {
        let target = FakeBackend
            .targets(&Cancellation::default())
            .unwrap()
            .remove(1);
        Self(Arc::new(Mutex::new(BackendState {
            target: Some(target),
            inventory_truncated: false,
            invalid_pixels: false,
            cancel_inventory: false,
            cancel_capture: false,
        })))
    }
}

impl CaptureBackend for ControlledBackend {
    fn inventory_truncated(&self) -> bool {
        self.0.lock().unwrap().inventory_truncated
    }
    fn name(&self) -> &'static str {
        "controlled"
    }
    fn available(&self) -> bool {
        true
    }
    fn targets(&mut self, cancel: &Cancellation) -> Result<Vec<Target>> {
        cancel.check()?;
        let state = self.0.lock().unwrap();
        if state.cancel_inventory {
            cancel.cancel();
        }
        Ok(state.target.clone().into_iter().collect())
    }
    fn capture(&mut self, _target: &Target, cancel: &Cancellation) -> Result<Capture> {
        cancel.check()?;
        let state = self.0.lock().unwrap();
        let target = state
            .target
            .clone()
            .ok_or_else(|| CuaError::new(ErrorCode::TargetNotFound, "Controlled window closed."))?;
        let mut rgba = vec![64; target.pixel_width as usize * target.pixel_height as usize * 4];
        if state.invalid_pixels {
            rgba.pop();
        }
        if state.cancel_capture {
            cancel.cancel();
        }
        Ok(Capture {
            raster: Raster {
                width: target.pixel_width,
                height: target.pixel_height,
                rgba,
            },
            target,
        })
    }
}

#[test]
fn cancellation_after_inventory_does_not_commit_a_new_session() {
    let backend = ControlledBackend::new();
    backend.0.lock().unwrap().cancel_inventory = true;
    let mut service = CuaService::new(backend);
    assert_eq!(
        error_code(&mut service, attach(&binding(), "fake-window", 1)),
        ErrorCode::Cancelled
    );
    assert_eq!(service.session_count(), 0);
}

#[test]
fn bounded_inventory_discloses_truncation_without_changing_complete_inventory() {
    let backend = ControlledBackend::new();
    let control = backend.clone();
    let mut service = CuaService::new(backend);
    let complete = apply(&mut service, Operation::TargetsList {});
    assert!(complete.data.get("truncated").is_none());
    control.0.lock().unwrap().inventory_truncated = true;
    let limited = apply(&mut service, Operation::TargetsList {});
    assert_eq!(limited.data["truncated"], true);
    assert_eq!(limited.data["targets"], complete.data["targets"]);
}

#[test]
fn cancellation_after_native_capture_does_not_commit_an_observation() {
    let backend = ControlledBackend::new();
    let control = backend.clone();
    let mut service = CuaService::new(backend);
    let owner = binding();
    apply(&mut service, attach(&owner, "fake-window", 1));
    control.0.lock().unwrap().cancel_capture = true;
    assert_eq!(
        error_code(&mut service, snapshot(&owner, 1)),
        ErrorCode::Cancelled
    );
    control.0.lock().unwrap().cancel_capture = false;
    assert_eq!(
        state(&apply(&mut service, snapshot(&owner, 1))).observation_revision,
        1
    );
}

#[test]
fn closed_recreated_and_invalid_pixel_targets_report_precise_errors_without_fallback() {
    let backend = ControlledBackend::new();
    let control = backend.clone();
    let original = control.0.lock().unwrap().target.clone().unwrap();
    let mut service = CuaService::new(backend);
    let owner = binding();
    apply(&mut service, attach(&owner, "fake-window", 1));
    control.0.lock().unwrap().target = None;
    assert_eq!(
        error_code(&mut service, snapshot(&owner, 1)),
        ErrorCode::TargetNotFound
    );
    control.0.lock().unwrap().target = Some(Target {
        generation: 2,
        ..original.clone()
    });
    assert_eq!(
        error_code(&mut service, snapshot(&owner, 1)),
        ErrorCode::StaleTarget
    );
    {
        let mut native = control.0.lock().unwrap();
        native.target = Some(original);
        native.invalid_pixels = true;
    }
    assert_eq!(
        error_code(&mut service, snapshot(&owner, 1)),
        ErrorCode::InvalidRequest
    );
    control.0.lock().unwrap().invalid_pixels = false;
    assert_eq!(
        state(&apply(&mut service, snapshot(&owner, 1))).observation_revision,
        1
    );
    assert_eq!(service.session_count(), 1);
}

#[test]
fn resize_drops_out_of_bounds_trail_but_preserves_a_still_valid_cursor_position() {
    for final_position in [Point { x: 5.0, y: 5.0 }, Point { x: 150.0, y: 90.0 }] {
        let backend = ControlledBackend::new();
        let control = backend.clone();
        let mut service = CuaService::new(backend);
        let owner = binding();
        apply(&mut service, attach(&owner, "fake-window", 1));
        let appearance = configure(&mut service, &owner);
        move_cursor(&mut service, &owner, 150.0, 90.0);
        move_cursor(&mut service, &owner, final_position.x, final_position.y);
        {
            let mut native = control.0.lock().unwrap();
            let target = native.target.as_mut().unwrap();
            target.bounds.width = 64.0;
            target.bounds.height = 40.0;
            target.pixel_width = 128;
            target.pixel_height = 80;
        }
        let result = apply(&mut service, snapshot(&owner, 1));
        let observed = state(&result);
        assert_eq!(result.data["image"]["width"], 128);
        assert_eq!(result.data["image"]["height"], 80);
        let expected = if final_position.x < 64.0 {
            final_position
        } else {
            Point::default()
        };
        assert_eq!(observed.cursor.position, expected);
        assert!(observed.cursor.trail_points.is_empty());
        assert_eq!(observed.cursor.appearance, appearance);
        assert_eq!(observed.target.unwrap().generation, 1);
    }
}
