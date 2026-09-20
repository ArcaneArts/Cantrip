//! A prepared, authorized native operation that does not borrow the request loop.
//! There are no threads or deadlines here; the runtime owns bounded execution.
use crate::{
    cursor::CursorState,
    error::Result,
    input::InputReceipt,
    target::{Bounds, Point, Target},
};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
pub type InputResult = Result<(Target, InputReceipt)>;
pub type InputWork = Box<dyn FnOnce(&mut dyn FnMut(Point)) -> InputResult + Send>;
/// Latest-only cursor state, including its bounded trail. Long gestures never
/// build a per-frame message backlog or lose their last position on failure.
#[derive(Clone)]
pub struct InputProgress {
    cursor: Arc<Mutex<CursorState>>,
    bounds: Bounds,
    started: Instant,
    now_ms: u64,
}
impl InputProgress {
    pub fn new(cursor: CursorState, bounds: Bounds, now_ms: u64) -> Self {
        Self {
            cursor: Arc::new(Mutex::new(cursor)),
            bounds,
            started: Instant::now(),
            now_ms,
        }
    }
    fn now(&self) -> u64 {
        self.now_ms
            .saturating_add(self.started.elapsed().as_millis() as u64)
    }
    pub fn set(&self, point: Point) {
        let _ = self
            .cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .move_to(point, &self.bounds, self.now());
    }
    pub fn mark_action(&self, method: &'static str) {
        self.cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mark_action(method, "unknown", self.now());
    }
    pub fn cursor(&self) -> CursorState {
        self.cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_preserves_bounded_trail_feedback_and_independent_state() {
        let bounds = Bounds {
            x: 0.0,
            y: 0.0,
            width: 1000.0,
            height: 200.0,
        };
        let mut cursor = CursorState::new();
        cursor.appearance.trail = true;
        let first = InputProgress::new(cursor.clone(), bounds, 1000);
        let second = InputProgress::new(cursor, bounds, 1000);
        let job = first.clone();
        std::thread::spawn(move || {
            for x in 1..1000 {
                job.set(Point {
                    x: f64::from(x),
                    y: 10.0,
                });
            }
            job.mark_action("background-drag");
        })
        .join()
        .unwrap();
        let current = first.cursor();
        assert_eq!(current.position, Point { x: 999.0, y: 10.0 });
        assert_eq!(current.trail_points.len(), crate::cursor::MAX_TRAIL_POINTS);
        assert_eq!(current.action.unwrap().method, "background-drag");
        assert_eq!(second.cursor().position, Point::default());
        // Invalid presentation coordinates cannot poison the latest valid state.
        first.set(Point {
            x: f64::NAN,
            y: 0.0,
        });
        assert_eq!(first.cursor().position, current.position);
    }
}
