//! Private synthetic input must coexist with the human driving the local viewer.
use std::ffi::c_void;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGEventSourceCreate(state: i32) -> *const c_void;
    fn CGEventSourceSetLocalEventsSuppressionInterval(source: *const c_void, seconds: f64);
    fn CGEventSourceSetLocalEventsFilterDuringSuppressionState(
        source: *const c_void,
        filter: u32,
        state: u32,
    );
}

/// Returns a CF-owned source (or null); the caller's event wrapper releases it.
pub(super) fn create() -> *const c_void {
    let source = unsafe { CGEventSourceCreate(-1) }; // kCGEventSourceStatePrivate
    if !source.is_null() {
        // Quartz otherwise defaults to a 250 ms suppression interval. A remote
        // event must never suppress the local mouse/keyboard feeding Cantrip,
        // including while a synthetic mouse button remains held.
        const PERMIT_ALL_EVENTS: u32 = 1 | 2 | 4;
        unsafe {
            CGEventSourceSetLocalEventsSuppressionInterval(source, 0.0);
            CGEventSourceSetLocalEventsFilterDuringSuppressionState(source, PERMIT_ALL_EVENTS, 0);
            CGEventSourceSetLocalEventsFilterDuringSuppressionState(source, PERMIT_ALL_EVENTS, 1);
        }
    }
    source
}

#[cfg(test)]
mod tests {
    use super::*;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceGetLocalEventsSuppressionInterval(source: *const c_void) -> f64;
        fn CGEventSourceGetLocalEventsFilterDuringSuppressionState(
            source: *const c_void,
            state: u32,
        ) -> u32;
        fn CGEventSourceGetSourceStateID(source: *const c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }
    struct Source(*const c_void);
    impl Drop for Source {
        fn drop(&mut self) {
            unsafe { CFRelease(self.0) };
        }
    }

    #[test]
    fn private_source_never_suppresses_local_input_after_posts_or_during_drags() {
        // Inspect real Quartz source settings without posting input, changing
        // host focus, or touching the shared HID/session event-state tables.
        let source = create();
        assert!(!source.is_null());
        let source = Source(source);
        unsafe {
            assert!(![0, 1].contains(&CGEventSourceGetSourceStateID(source.0)));
            assert_eq!(
                CGEventSourceGetLocalEventsSuppressionInterval(source.0),
                0.0
            );
            for state in [0, 1] {
                assert_eq!(
                    CGEventSourceGetLocalEventsFilterDuringSuppressionState(source.0, state),
                    7
                );
            }
        }
    }
}
