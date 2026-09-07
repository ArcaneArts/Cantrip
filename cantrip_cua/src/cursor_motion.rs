//! Short custom-cursor travel before ordinary clicks. Never posts native input.
use crate::{cancellation::Cancellation, error::Result, target::Point};
use std::time::Duration;

pub fn travel(start: Point, end: Point) -> Vec<(Duration, Point)> {
    let distance = (end.x - start.x).hypot(end.y - start.y);
    if distance < 1.0 {
        return vec![(Duration::ZERO, end)];
    }
    // At least four smooth steps when timing allows, rather than two large
    // jumps for nearby piano keys. Cross-window travel still caps at 90 ms.
    let ms = (distance / 4.0).clamp(60.0, 90.0);
    let steps = (ms / (1000.0 / 60.0)).ceil() as u32;
    (1..=steps)
        .map(|i| {
            let t = f64::from(i) / f64::from(steps);
            // Cubic ease-out: maximum speed immediately, then deceleration.
            let eased = 1.0 - (1.0 - t).powi(3);
            let point = if i == steps {
                end
            } else {
                Point {
                    x: start.x + (end.x - start.x) * eased,
                    y: start.y + (end.y - start.y) * eased,
                }
            };
            (Duration::from_secs_f64(ms * t / 1000.0), point)
        })
        .collect()
}

/// Fit visual travel into an existing release-to-press gap without delaying input.
pub fn before_deadline(
    start: Point,
    end: Point,
    available: Duration,
    deadline: Duration,
) -> Vec<(Duration, Point)> {
    let gap = deadline.saturating_sub(available);
    if gap.is_zero() || start == end {
        return vec![];
    }
    let path = travel(start, end);
    let duration = path.last().unwrap().0;
    if duration.is_zero() {
        return vec![];
    }
    let allotted = duration.min(gap);
    let begins = deadline - allotted;
    path.into_iter()
        .map(|(at, point)| {
            (
                begins + allotted.mul_f64(at.as_secs_f64() / duration.as_secs_f64()),
                point,
            )
        })
        .collect()
}

pub fn animate(
    points: &[(Duration, Point)],
    cancel: &Cancellation,
    mut wait: impl FnMut(Duration) -> Result<()>,
    mut present: impl FnMut(Point) -> Result<()>,
) -> Result<()> {
    for &(at, point) in points {
        wait(at)?;
        cancel.check()?;
        present(point)?;
    }
    // Stop during a queued presentation must prevent the following click.
    cancel.check()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn timeline_gap_compresses_travel_and_keeps_the_deadline() {
        let start = Point { x: 0.0, y: 0.0 };
        let end = Point { x: 900.0, y: 200.0 };
        for gap in [1, 10, 50, 115] {
            let available = Duration::from_millis(105);
            let deadline = available + Duration::from_millis(gap);
            let points = before_deadline(start, end, available, deadline);
            assert_eq!(points.last(), Some(&(deadline, end)));
            assert!(
                points
                    .iter()
                    .all(|(at, _)| *at > available && *at <= deadline)
            );
        }
        assert!(before_deadline(start, end, Duration::ZERO, Duration::ZERO).is_empty());
    }
    #[test]
    fn fast_travel_is_bounded_and_lands_exactly_without_overshoot() {
        let start = Point { x: 25.0, y: 400.0 };
        for end in [
            start,
            Point { x: 25.5, y: 400.0 },
            Point { x: 5000.0, y: 2.0 },
        ] {
            let points = travel(start, end);
            assert_eq!(points.last().unwrap().1, end);
            assert!(points.last().unwrap().0 <= Duration::from_millis(90));
            assert!(points.len() <= 6);
            let mut last = Duration::ZERO;
            let mut previous = start;
            let mut previous_step = f64::INFINITY;
            for (at, p) in points {
                let step = (p.x - previous.x).hypot(p.y - previous.y);
                assert!(
                    step <= previous_step,
                    "equal-time steps must decelerate from the start"
                );
                previous = p;
                previous_step = step;
                assert!(at >= last);
                last = at;
                assert!((start.x.min(end.x)..=start.x.max(end.x)).contains(&p.x));
                assert!((start.y.min(end.y)..=start.y.max(end.y)).contains(&p.y));
            }
        }
        assert_eq!(travel(start, start), vec![(Duration::ZERO, start)]);
    }
    #[test]
    fn stop_during_presentation_cancels_before_click_and_preserves_last_point() {
        let cancel = Cancellation::default();
        let points = travel(Point { x: 0.0, y: 0.0 }, Point { x: 500.0, y: 0.0 });
        let mut shown = vec![];
        let result = animate(
            &points,
            &cancel,
            |_| Ok(()),
            |point| {
                shown.push(point);
                cancel.cancel();
                Ok(())
            },
        );
        assert_eq!(result.unwrap_err().code, crate::error::ErrorCode::Cancelled);
        assert_eq!(shown, vec![points[0].1]);
        // Also fence cancellation while rendering the last frame.
        let cancel = Cancellation::default();
        assert!(
            animate(
                &points[..1],
                &cancel,
                |_| Ok(()),
                |_| {
                    cancel.cancel();
                    Ok(())
                }
            )
            .is_err()
        );
    }
}
