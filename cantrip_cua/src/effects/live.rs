//! Shared presentation/input state. No rendering or platform calls while locked.
use super::{
    now_ns,
    telemetry::{Agent, InputEvent, Telemetry},
};
use crate::{
    service::SessionState,
    target::{Point, Target},
};
use std::sync::{Mutex, OnceLock};
fn state() -> &'static Mutex<Telemetry> {
    static STATE: OnceLock<Mutex<Telemetry>> = OnceLock::new();
    STATE.get_or_init(Mutex::default)
}
fn with<T>(f: impl FnOnce(&mut Telemetry) -> T) -> T {
    f(&mut state().lock().unwrap_or_else(|e| e.into_inner()))
}
pub fn synchronize(sessions: &[SessionState]) {
    with(|s| s.synchronize(sessions, now_ns()));
}
pub fn movement(session: &str, target: &Target, point: Point, discontinuity: bool) {
    with(|s| s.movement(session, target, point, now_ns(), discontinuity));
}
pub fn input(session: &str, target: &Target, event: InputEvent) {
    with(|s| s.input(session, target, event, now_ns()));
}
pub fn window(target: &Target, now: u64) -> Vec<Agent> {
    with(|s| s.window(&target.id, target.generation, now))
}

pub fn geometry(target: &Target) {
    with(|s| s.geometry(target, now_ns()));
}
