//! Experimental SPI delivery. Resolve only on explicit background input.
//! No authentication envelope, dual posting, activation, or global fallback.
use crate::{
    error::{CuaError, ErrorCode, Result},
    target::Point,
};
use std::{
    ffi::{c_char, c_int, c_void},
    sync::OnceLock,
};

type Event = *const c_void;
#[repr(C)]
struct NativePoint {
    x: f64,
    y: f64,
}
type Post = unsafe extern "C" fn(i32, Event);
type Location = unsafe extern "C" fn(Event, NativePoint);
type Field = unsafe extern "C" fn(Event, u32, i64);
unsafe extern "C" {
    fn dlopen(path: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}
#[derive(Clone, Copy)]
pub(super) struct Delivery {
    post: Post,
    location: Location,
    field: Field,
}
impl Delivery {
    pub fn load() -> Result<Self> {
        static API: OnceLock<Option<Delivery>> = OnceLock::new();
        // The open handle is intentionally retained for the helper lifetime.
        // Looking up required functions is part of performing this method, not a
        // heuristic permission or target-readiness gate.
        API.get_or_init(|| unsafe {
            let handle = dlopen(
                c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight".as_ptr(),
                2,
            );
            if handle.is_null() {
                return None;
            }
            let post = dlsym(handle, c"SLEventPostToPid".as_ptr());
            let field = dlsym(handle, c"SLEventSetIntegerValueField".as_ptr());
            // This SPI is exported by CoreGraphics and can be resolved in the
            // process's already-loaded images on macOS (RTLD_DEFAULT = -2).
            let location = dlsym(
                (-2_isize) as *mut c_void,
                c"CGEventSetWindowLocation".as_ptr(),
            );
            if post.is_null() || field.is_null() || location.is_null() {
                return None;
            }
            Some(Self {
                post: std::mem::transmute::<*mut c_void, Post>(post),
                field: std::mem::transmute::<*mut c_void, Field>(field),
                location: std::mem::transmute::<*mut c_void, Location>(location),
            })
        })
        .ok_or_else(|| {
            CuaError::new(
                ErrorCode::Unsupported,
                "Experimental background input SPI is unavailable; no input was posted.",
            )
        })
    }
    pub unsafe fn prepare(
        &self,
        event: Event,
        pid: i32,
        window: u32,
        point: Point,
        group: i64,
        click_state: i64,
    ) {
        unsafe {
            (self.location)(
                event,
                NativePoint {
                    x: point.x,
                    y: point.y,
                },
            );
            for (field, value) in routing_fields(pid, window, group, click_state) {
                (self.field)(event, field, value);
            }
        }
    }
    /// Destination fields shared by keyboard, wheel and mouse events. Do not
    /// write mouse-specific pressure/button fields onto keyboard or wheel data.
    pub unsafe fn prepare_routed(
        &self,
        event: Event,
        pid: i32,
        window: u32,
        point: Point,
        group: i64,
    ) {
        unsafe {
            (self.location)(
                event,
                NativePoint {
                    x: point.x,
                    y: point.y,
                },
            );
            for (field, value) in [
                (40, i64::from(pid)),
                (51, i64::from(window)),
                (58, group),
                (91, i64::from(window)),
                (92, i64::from(window)),
            ] {
                (self.field)(event, field, value);
            }
        }
    }
    pub unsafe fn post(&self, pid: i32, event: Event) {
        unsafe { (self.post)(pid, event) };
    }
}
fn routing_fields(pid: i32, window: u32, group: i64, click_state: i64) -> [(u32, i64); 8] {
    [
        (1, click_state),
        (3, 0),
        (7, 3),
        (40, i64::from(pid)),
        (51, i64::from(window)),
        (58, group),
        (91, i64::from(window)),
        (92, i64::from(window)),
    ]
}
#[cfg(test)]
mod tests {
    #[test]
    fn all_events_share_exact_destination_and_group() {
        let movement = super::routing_fields(77, 123, 42, 0);
        let click = super::routing_fields(77, 123, 42, 1);
        assert_eq!(movement[0], (1, 0));
        assert_eq!(click[0], (1, 1));
        assert_eq!(movement[1..], click[1..]);
        assert!(click.contains(&(40, 77)));
        for field in [51, 91, 92] {
            assert!(click.contains(&(field, 123)));
        }
    }
}

pub(super) fn next_group() -> i64 {
    use std::sync::atomic::{AtomicI64, Ordering};
    static GROUP: AtomicI64 = AtomicI64::new(1);
    GROUP.fetch_add(1, Ordering::Relaxed)
}
