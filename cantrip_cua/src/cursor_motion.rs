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

/// A timed cubic Bezier segment sampled lazily. Storage is independent of the
/// gap duration, so a long musical rest never allocates thousands of frames.
#[derive(Clone, Debug)]
pub struct TimedSpline {
    start: Point,
    end: Point,
    controls: [Point; 2],
    begins: Duration,
    duration: Duration,
    sample: u64,
    samples: u64,
}
impl TimedSpline {
    pub fn new(
        previous: Option<Point>,
        start: Point,
        end: Point,
        next: Option<Point>,
        begins: Duration,
        deadline: Duration,
    ) -> Option<Self> {
        let duration = deadline.saturating_sub(begins);
        if duration.is_zero() || start == end {
            return None;
        }
        // Neighboring click locations give the spline a natural entry/exit
        // direction. Keep its control hull inside the endpoints' rectangle:
        // the visual path cannot overshoot the target window or a piano row.
        let clamp = |p: Point| Point {
            x: p.x.clamp(start.x.min(end.x), start.x.max(end.x)),
            y: p.y.clamp(start.y.min(end.y), start.y.max(end.y)),
        };
        let previous = previous.unwrap_or(start);
        let next = next.unwrap_or(end);
        let controls = [
            clamp(Point {
                x: start.x + (end.x - previous.x) / 6.0,
                y: start.y + (end.y - previous.y) / 6.0,
            }),
            clamp(Point {
                x: end.x - (next.x - start.x) / 6.0,
                y: end.y - (next.y - start.y) / 6.0,
            }),
        ];
        Some(Self {
            start,
            end,
            controls,
            begins,
            duration,
            sample: 0,
            samples: (duration.as_secs_f64() * 60.0).ceil().max(1.0) as u64,
        })
    }
    fn sample_position(&self, t: f64) -> Point {
        if t >= 1.0 {
            return self.end;
        }
        // Known deadlines allow smooth acceleration and braking across the
        // whole gap. Unknown future actions retain travel()'s cubic ease-out.
        let t = (t * t * t * (10.0 + t * (-15.0 + 6.0 * t))).clamp(0.0, 1.0);
        let u = 1.0 - t;
        let axis =
            |a, b, c, d| u * u * u * a + 3.0 * u * u * t * b + 3.0 * u * t * t * c + t * t * t * d;
        Point {
            x: axis(
                self.start.x,
                self.controls[0].x,
                self.controls[1].x,
                self.end.x,
            )
            .clamp(self.start.x.min(self.end.x), self.start.x.max(self.end.x)),
            y: axis(
                self.start.y,
                self.controls[0].y,
                self.controls[1].y,
                self.end.y,
            )
            .clamp(self.start.y.min(self.end.y), self.start.y.max(self.end.y)),
        }
    }
}
impl Iterator for TimedSpline {
    type Item = (Duration, Point);
    fn next(&mut self) -> Option<Self::Item> {
        if self.sample == self.samples {
            return None;
        }
        self.sample += 1;
        let t = self.sample as f64 / self.samples as f64;
        let at = if self.sample == self.samples {
            self.begins + self.duration
        } else {
            self.begins + self.duration.mul_f64(t)
        };
        Some((at, self.sample_position(t)))
    }
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
    fn timed_splines_use_the_full_gap_and_land_without_overshoot() {
        let start = Point { x: 100., y: 200. };
        let end = Point { x: 900., y: 500. };
        for ms in [1, 6, 16, 50, 115, 1000, 3000] {
            let begins = Duration::from_millis(105);
            let deadline = begins + Duration::from_millis(ms);
            let points: Vec<_> = TimedSpline::new(
                Some(Point { x: 0., y: 900. }),
                start,
                end,
                Some(Point { x: 1500., y: 10. }),
                begins,
                deadline,
            )
            .unwrap()
            .collect();
            assert_eq!(points.last(), Some(&(deadline, end)));
            assert!(points[0].0 - begins <= Duration::from_millis(17));
            assert!(points.windows(2).all(|w| w[0].0 < w[1].0));
            for (_, p) in &points {
                assert!((100.0..=900.0).contains(&p.x));
                assert!((200.0..=500.0).contains(&p.y));
            }
            if ms <= 16 {
                assert_eq!(points.len(), 1);
            }
            if ms >= 1000 {
                let halfway = points[points.len() / 2 - 1].1;
                assert!(halfway.x > start.x + 100. && halfway.x < end.x - 100.);
                assert!(points.len() >= 60);
            }
        }
        assert!(TimedSpline::new(None, start, end, None, Duration::ZERO, Duration::ZERO).is_none());
        assert!(
            TimedSpline::new(
                None,
                start,
                start,
                None,
                Duration::ZERO,
                Duration::from_secs(1)
            )
            .is_none()
        );
    }
    #[test]
    fn lookahead_bends_the_path_and_long_gaps_stay_lazy() {
        let start = Point { x: 0., y: 0. };
        let end = Point { x: 500., y: 500. };
        let straight = TimedSpline::new(
            None,
            start,
            end,
            None,
            Duration::ZERO,
            Duration::from_secs(2),
        )
        .unwrap();
        let curved = TimedSpline::new(
            Some(Point { x: 0., y: 500. }),
            start,
            end,
            Some(Point { x: 1000., y: 500. }),
            Duration::ZERO,
            Duration::from_secs(2),
        )
        .unwrap();
        assert_ne!(straight.sample_position(0.25), curved.sample_position(0.25));
        let mut long = TimedSpline::new(
            None,
            start,
            end,
            None,
            Duration::ZERO,
            Duration::from_secs(7200),
        )
        .unwrap();
        assert!(std::mem::size_of_val(&long) < 256);
        assert_eq!(long.samples, 432000);
        assert!(long.next().unwrap().0 <= Duration::from_millis(17));
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
