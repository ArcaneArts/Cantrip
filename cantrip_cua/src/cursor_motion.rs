//! CUA scheduling adapter for shared cursor paths.
use crate::{cancellation::Cancellation, error::Result, target::Point};
pub use cantrip_interaction::motion::{TimedSpline, travel};
use std::time::Duration;

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
