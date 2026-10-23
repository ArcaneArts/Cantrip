//! Continuous remote input refreshes one WindowServer record, not the slow
//! asynchronous ScreenCaptureKit inventory. Discovery/capture still use SCK.
use super::{geometry, overlay, registry::Identity};
use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::Target,
};
use objc2::{
    msg_send,
    rc::{Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject},
};
use objc2_foundation::NSString;

pub(super) fn resolve(
    target: &Target,
    expected: &Identity,
    cancel: &Cancellation,
) -> Result<Target> {
    cancel.check()?;
    let (_, id) = super::click::process_destination(target)?;
    let window = overlay::window(id).ok_or_else(|| {
        CuaError::new(
            ErrorCode::TargetNotFound,
            "Remote input window no longer exists.",
        )
    })?;
    // NSRunningApplication exposes thread-safe process metadata. Only owned
    // strings escape this pool; no AppKit object crosses executor boundaries.
    // https://developer.apple.com/documentation/appkit/nsrunningapplication
    let application_id = autoreleasepool(|_| unsafe {
        let class = AnyClass::get(c"NSRunningApplication")?;
        let application: Option<Retained<AnyObject>> = msg_send![class, runningApplicationWithProcessIdentifier: i32::try_from(window.pid).ok()?];
        let application = application?;
        let bundle: Option<Retained<NSString>> = msg_send![&*application, bundleIdentifier];
        Some(geometry::bounded_text(
            bundle.map(|value| value.to_string()).unwrap_or_default(),
            1024,
        ))
    });
    cancel.check()?;
    refreshed(target, expected, &window, application_id)
}

fn refreshed(
    target: &Target,
    expected: &Identity,
    window: &overlay::Window,
    application_id: Option<String>,
) -> Result<Target> {
    let actual = Identity {
        process_id: Some(window.pid),
        application_id,
    };
    if actual != *expected || target.process_id != actual.process_id {
        return Err(CuaError::new(
            ErrorCode::StaleTarget,
            "Remote input window owner was replaced.",
        ));
    }
    let (bounds, scale_factor, pixel_width, pixel_height) = geometry::inventory_geometry(
        window.bounds.x,
        window.bounds.y,
        window.bounds.width,
        window.bounds.height,
    )?;
    let current = Target {
        bounds,
        scale_factor,
        pixel_width,
        pixel_height,
        ..target.clone()
    };
    current.validate()?;
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        backend::{CaptureBackend, FakeBackend},
        target::{Bounds, TargetKind},
    };
    fn fixture() -> (Target, Identity, overlay::Window) {
        let mut target = FakeBackend
            .targets(&Cancellation::default())
            .unwrap()
            .into_iter()
            .find(|t| t.kind == TargetKind::Window)
            .unwrap();
        target.id = "macos-window-42".into();
        target.process_id = Some(7);
        let identity = Identity {
            process_id: Some(7),
            application_id: Some("fixture".into()),
        };
        let window = overlay::Window {
            id: 42,
            pid: 7,
            level: 0,
            bounds: Bounds {
                x: -900.0,
                y: 30.0,
                width: 800.0,
                height: 600.0,
            },
        };
        (target, identity, window)
    }
    #[test]
    fn refreshes_actual_geometry_without_rebinding_the_discovered_incarnation() {
        let (target, identity, window) = fixture();
        let current = refreshed(&target, &identity, &window, Some("fixture".into())).unwrap();
        assert_eq!(current.id, target.id);
        assert_eq!(current.generation, target.generation);
        assert_eq!(current.bounds, window.bounds);
        assert_eq!(current.pixel_width, 800);
        assert_eq!(current.pixel_height, 600);
    }
    #[test]
    fn rejects_a_reused_window_owned_by_another_process() {
        let (target, identity, mut window) = fixture();
        window.pid = 8;
        assert_eq!(
            refreshed(&target, &identity, &window, Some("fixture".into()))
                .unwrap_err()
                .code,
            ErrorCode::StaleTarget
        );
    }
    #[test]
    fn rejects_an_application_identity_change_or_missing_process_metadata() {
        let (target, identity, window) = fixture();
        for app in [Some("replacement".into()), None] {
            assert_eq!(
                refreshed(&target, &identity, &window, app)
                    .unwrap_err()
                    .code,
                ErrorCode::StaleTarget
            );
        }
    }
    #[test]
    fn cancellation_does_not_attempt_native_resolution() {
        let (target, identity, _) = fixture();
        let cancel = Cancellation::default();
        cancel.cancel();
        assert_eq!(
            resolve(&target, &identity, &cancel).unwrap_err().code,
            ErrorCode::Cancelled
        );
    }
}
