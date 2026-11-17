use cantrip_wire::{Value, value::json};
use cantrip_worker::protected_content::SurfaceStreamReplayGuard;
fn context(operation: usize, sequence: u64) -> Value {
    json!({"serverId":"server","surfaceKind":"terminal","surfaceId":"terminal","operationId":format!("operation-{operation}"),"direction":"input","sequence":sequence})
}
#[test]
fn reservation_is_consumed_before_opening_and_completion_blocks_replay() {
    let mut guard = SurfaceStreamReplayGuard::default();
    let first = context(0, 0);
    let second = context(0, 1);
    assert!(guard.accept(&first, false).is_err());
    guard.reserve(&first).unwrap();
    assert!(
        guard
            .reserve(&first)
            .unwrap_err()
            .to_string()
            .contains("sequence 1")
    );
    // The failed consumer does not implicitly release its reservation. A later
    // admitted sequence supersedes the earlier in-flight acceptance.
    guard.reserve(&second).unwrap();
    assert!(guard.accept(&first, true).is_err());
    guard.accept(&second, true).unwrap();
    assert!(
        guard
            .reserve(&context(0, 2))
            .unwrap_err()
            .to_string()
            .contains("completed")
    );
    guard.release(&first);
    guard.reserve(&first).unwrap();
    let mut other = first.clone();
    other["serverId"] = json!("other-server");
    guard.reserve(&other).unwrap();
}
#[test]
fn active_operations_are_bounded_and_completed_replay_records_age_out() {
    let mut active = SurfaceStreamReplayGuard::default();
    let mut completed = SurfaceStreamReplayGuard::default();
    for operation in 0..10_000 {
        let context = context(operation, 0);
        active.reserve(&context).unwrap();
        completed.reserve(&context).unwrap();
        completed.accept(&context, true).unwrap();
    }
    assert!(
        active
            .reserve(&context(10_000, 0))
            .unwrap_err()
            .to_string()
            .contains("Too many")
    );
    active.release(&context(0, 0));
    active.reserve(&context(10_000, 0)).unwrap();
    assert!(completed.reserve(&context(0, 0)).is_err());
    completed.reserve(&context(10_000, 0)).unwrap();
    completed.accept(&context(10_000, 0), true).unwrap();
    completed.reserve(&context(0, 0)).unwrap();
    assert!(completed.reserve(&context(1, 0)).is_err());
}
