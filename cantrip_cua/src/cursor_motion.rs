//! Short custom-cursor travel before ordinary clicks. Never posts native input.
use crate::{cancellation::Cancellation, error::Result, target::Point};
use std::time::Duration;

pub fn travel(start: Point, end: Point) -> Vec<(Duration, Point)> {
    let distance = (end.x - start.x).hypot(end.y - start.y);
    if distance < 1.0 {
        return vec![(Duration::ZERO, end)];
    }
    // Roughly 4 logical pixels/ms, capped so even a cross-window jump is fast.
    let ms = (distance / 4.0).clamp(30.0, 90.0);
    let steps = (ms / (1000.0 / 60.0)).ceil() as u32;
    (1..=steps)
        .map(|i| {
            let t = f64::from(i) / f64::from(steps);
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
            for (at, p) in points {
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
