//! Cursor paths only. Input dispatch, cancellation, and clocks belong to adapters.
use crate::geometry::Point;
use std::time::Duration;

/// Presentation policy is independent of the event scheduler. Human adapters
/// use Immediate; agents may use EaseOut or a known arrival deadline.
#[derive(Clone, Copy, Debug)]
pub enum Motion {
    Immediate,
    EaseOut,
    /// Linear native drag motion, sampled lazily at approximately 60 Hz.
    Linear {
        duration: Duration,
    },
    Scheduled {
        previous: Option<Point>,
        next: Option<Point>,
        begins: Duration,
        deadline: Duration,
    },
}
pub enum MotionPath {
    Steps(std::vec::IntoIter<(Duration, Point)>),
    Spline(TimedSpline),
    Linear(TimedLinear),
}
impl Motion {
    pub fn path(self, start: Point, end: Point) -> crate::error::Result<MotionPath> {
        let finite = |point: Point| point.x.is_finite() && point.y.is_finite();
        if !finite(start) || !finite(end) {
            return Err(crate::error::ValidationError::invalid(
                "Non-finite cursor path.",
            ));
        }
        let steps = match self {
            Self::Immediate => vec![(Duration::ZERO, end)],
            Self::EaseOut => travel(start, end),
            Self::Linear { duration } => {
                return Ok(MotionPath::Linear(TimedLinear::new(start, end, duration)));
            }
            Self::Scheduled {
                previous,
                next,
                begins,
                deadline,
            } => {
                if deadline < begins
                    || previous.is_some_and(|p| !finite(p))
                    || next.is_some_and(|p| !finite(p))
                {
                    return Err(crate::error::ValidationError::invalid(
                        "Invalid scheduled cursor path.",
                    ));
                }
                if let Some(spline) = TimedSpline::new(previous, start, end, next, begins, deadline)
                {
                    return Ok(MotionPath::Spline(spline));
                }
                vec![(deadline, end)]
            }
        };
        Ok(MotionPath::Steps(steps.into_iter()))
    }
}
impl Iterator for MotionPath {
    type Item = (Duration, Point);
    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Steps(steps) => steps.next(),
            Self::Spline(spline) => spline.next(),
            Self::Linear(line) => line.next(),
        }
    }
}

/// Portable presentation policy consumed by native travel and browser overlays.
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TravelPolicy {
    pub minimum_distance: f64,
    pub pixels_per_ms: f64,
    pub min_duration_ms: f64,
    pub max_duration_ms: f64,
    pub easing: [f64; 4],
}
pub const TRAVEL_POLICY: TravelPolicy = TravelPolicy {
    minimum_distance: 1.0,
    pixels_per_ms: 4.0,
    min_duration_ms: 60.0,
    max_duration_ms: 90.0,
    // Linear time axis, cubic ease-out position axis.
    easing: [1.0 / 3.0, 1.0, 2.0 / 3.0, 1.0],
};

pub fn travel(start: Point, end: Point) -> Vec<(Duration, Point)> {
    let distance = (end.x - start.x).hypot(end.y - start.y);
    if distance < TRAVEL_POLICY.minimum_distance {
        return vec![(Duration::ZERO, end)];
    }
    // At least four smooth steps when timing allows, rather than two large
    // jumps for nearby piano keys. Cross-window travel still caps at 90 ms.
    let ms = (distance / TRAVEL_POLICY.pixels_per_ms)
        .clamp(TRAVEL_POLICY.min_duration_ms, TRAVEL_POLICY.max_duration_ms);
    let steps = (ms / (1000.0 / 60.0)).ceil() as u32;
    (1..=steps)
        .map(|i| {
            let t = f64::from(i) / f64::from(steps);
            // Cubic ease-out: maximum speed immediately, then deceleration.
            let u = 1.0 - t;
            let eased = 3.0 * u * u * t * TRAVEL_POLICY.easing[1]
                + 3.0 * u * t * t * TRAVEL_POLICY.easing[3]
                + t * t * t;
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

/// Constant-space native drag path. Sample counts and timestamps use integer
/// arithmetic, including durations beyond a platform Instant's representable
/// deadline. A zero-duration drag still emits its endpoint before release.
#[derive(Clone, Debug)]
pub struct TimedLinear {
    start: Point,
    end: Point,
    duration: Duration,
    sample: u128,
    samples: u128,
}
impl TimedLinear {
    pub fn new(start: Point, end: Point, duration: Duration) -> Self {
        let samples = (u128::from(duration.as_secs()) * 60
            + (u128::from(duration.subsec_nanos()) * 60).div_ceil(1_000_000_000))
        .max(1);
        Self {
            start,
            end,
            duration,
            sample: 0,
            samples,
        }
    }
}
impl Iterator for TimedLinear {
    type Item = (Duration, Point);
    fn next(&mut self) -> Option<Self::Item> {
        if self.sample == self.samples {
            return None;
        }
        self.sample += 1;
        if self.sample == self.samples {
            return Some((self.duration, self.end));
        }
        let at = Duration::new(
            (self.sample / 60) as u64,
            ((self.sample % 60) * 1_000_000_000 / 60) as u32,
        );
        let t = at.as_secs_f64() / self.duration.as_secs_f64();
        Some((
            at,
            Point {
                x: self.start.x * (1.0 - t) + self.end.x * t,
                y: self.start.y * (1.0 - t) + self.end.y * t,
            },
        ))
    }
    fn nth(&mut self, n: usize) -> Option<Self::Item> {
        self.sample = (self.sample + n as u128).min(self.samples);
        self.next()
    }
    fn last(mut self) -> Option<Self::Item> {
        if self.sample == self.samples {
            return None;
        }
        self.sample = self.samples - 1;
        self.next()
    }
    fn size_hint(&self) -> (usize, Option<usize>) {
        match usize::try_from(self.samples - self.sample) {
            Ok(left) => (left, Some(left)),
            Err(_) => (usize::MAX, None),
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn linear_paths_are_lazy_precise_and_support_zero_or_extreme_durations() {
        let start = Point { x: 0.0, y: 100.0 };
        let end = Point { x: 120.0, y: 40.0 };
        let path: Vec<_> = TimedLinear::new(start, end, Duration::from_millis(200)).collect();
        assert_eq!(path.len(), 12);
        assert_eq!(path.last(), Some(&(Duration::from_millis(200), end)));
        assert!(
            path.windows(2)
                .all(|p| p[0].0 < p[1].0 && p[0].1.x < p[1].1.x)
        );
        assert_eq!(
            TimedLinear::new(start, end, Duration::ZERO).collect::<Vec<_>>(),
            vec![(Duration::ZERO, end)]
        );
        for duration in [
            Duration::from_millis(150_000),
            Duration::from_millis(9_007_199_254_740_991),
            Duration::MAX,
        ] {
            let mut path = TimedLinear::new(start, end, duration);
            assert!(std::mem::size_of_val(&path) < 128);
            let first = path.next().unwrap();
            assert!(first.0 <= Duration::from_millis(17));
            assert!(first.1.x.is_finite() && first.1.y.is_finite());
            assert_eq!(path.last(), Some((duration, end)));
        }
        let duration = Duration::from_millis(25);
        let points: Vec<_> = TimedLinear::new(start, end, duration).collect();
        assert_eq!(points.len(), 2);
        assert_eq!(points[1], (duration, end));
        assert!(points[0].0 < duration);
    }
    #[test]
    fn linear_policy_uses_the_shared_path_and_rejects_nonfinite_coordinates() {
        let end = Point { x: 10.0, y: 20.0 };
        let result = Motion::Linear {
            duration: Duration::ZERO,
        }
        .path(Point::default(), end)
        .unwrap()
        .collect::<Vec<_>>();
        assert_eq!(result, vec![(Duration::ZERO, end)]);
        assert!(
            Motion::Linear {
                duration: Duration::ZERO
            }
            .path(
                Point {
                    x: f64::NAN,
                    y: 0.0
                },
                end
            )
            .is_err()
        );
    }
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
}
