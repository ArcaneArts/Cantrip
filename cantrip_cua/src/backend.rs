use crate::{
    cancellation::Cancellation,
    error::{CuaError, ErrorCode, Result},
    target::{Bounds, MAX_IMAGE_PIXELS, Target, TargetKind},
};

pub struct Raster {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub struct Capture {
    pub target: Target,
    pub raster: Raster,
}

impl Raster {
    pub fn validate(&self) -> Result<()> {
        let pixels = (self.width as usize)
            .checked_mul(self.height as usize)
            .filter(|&p| p > 0 && p <= MAX_IMAGE_PIXELS)
            .ok_or_else(|| CuaError::invalid("Invalid capture dimensions."))?;
        if self.rgba.len() != pixels * 4 {
            return Err(CuaError::invalid("Invalid capture pixel buffer."));
        }
        Ok(())
    }
}

pub trait CaptureBackend: Send {
    fn native_input(&self) -> bool {
        false
    }
    fn clear_controls(&mut self, _session: &str) {}
    fn controls(
        &mut self,
        _session: &str,
        _target: &Target,
        _cancel: &Cancellation,
    ) -> Result<crate::input::Controls> {
        Err(CuaError::new(
            ErrorCode::Unsupported,
            "Accessibility inspection is unsupported.",
        ))
    }
    fn press(
        &mut self,
        _session: &str,
        _target: &Target,
        _reference: &str,
        _cancel: &Cancellation,
    ) -> Result<crate::input::InputReceipt> {
        Err(CuaError::new(
            ErrorCode::Unsupported,
            "Accessibility press is unsupported.",
        ))
    }
    fn click(
        &mut self,
        _session: &str,
        _target: &Target,
        _position: crate::target::Point,
        _cancel: &Cancellation,
    ) -> Result<(Target, crate::input::InputReceipt)> {
        Err(CuaError::new(
            ErrorCode::Unsupported,
            "Targeted cursor action is unsupported.",
        ))
    }
    fn global_click(
        &mut self,
        _session: &str,
        _target: &Target,
        _position: crate::target::Point,
        _cancel: &Cancellation,
    ) -> Result<(Target, crate::input::InputReceipt)> {
        Err(CuaError::new(
            ErrorCode::Unsupported,
            "Coordinate click is unsupported.",
        ))
    }
    fn name(&self) -> &'static str;
    fn available(&self) -> bool;
    fn targets(&mut self, cancellation: &Cancellation) -> Result<Vec<Target>>;
    fn inventory_truncated(&self) -> bool {
        false
    }
    fn target_page(
        &mut self,
        after: Option<&str>,
        cancellation: &Cancellation,
    ) -> Result<crate::inventory::TargetPage> {
        let targets = self.targets(cancellation)?;
        crate::inventory::page(targets, after, self.inventory_truncated())
    }
    fn resolve_target(
        &mut self,
        id: &str,
        generation: u64,
        cancellation: &Cancellation,
    ) -> Result<Target> {
        let target = self
            .targets(cancellation)?
            .into_iter()
            .find(|target| target.id == id)
            .ok_or_else(|| {
                CuaError::new(ErrorCode::TargetNotFound, "CUA target no longer exists.")
            })?;
        if target.generation != generation {
            return Err(CuaError::new(
                ErrorCode::StaleTarget,
                "CUA target was replaced.",
            ));
        }
        Ok(target)
    }
    fn capture(&mut self, target: &Target, cancellation: &Cancellation) -> Result<Capture>;
}

/// Explicit test backend; never used as a fallback for native failures.
#[derive(Default)]
pub struct FakeBackend;

impl CaptureBackend for FakeBackend {
    fn name(&self) -> &'static str {
        "fake"
    }
    fn available(&self) -> bool {
        true
    }
    fn targets(&mut self, cancellation: &Cancellation) -> Result<Vec<Target>> {
        cancellation.check()?;
        Ok(vec![
            Target {
                id: "fake-monitor".into(),
                generation: 1,
                kind: TargetKind::Monitor,
                title: Some("CUA fixture monitor".into()),
                application: None,
                process_id: None,
                bounds: Bounds {
                    x: -320.0,
                    y: -90.0,
                    width: 320.0,
                    height: 180.0,
                },
                pixel_width: 640,
                pixel_height: 360,
                scale_factor: 2.0,
                focused: None,
                minimized: None,
            },
            Target {
                id: "fake-window".into(),
                generation: 1,
                kind: TargetKind::Window,
                title: Some("CUA fixture window".into()),
                application: Some("Cantrip CUA fixture".into()),
                process_id: None,
                bounds: Bounds {
                    x: 24.0,
                    y: 32.0,
                    width: 160.0,
                    height: 100.0,
                },
                pixel_width: 320,
                pixel_height: 200,
                scale_factor: 2.0,
                focused: Some(false),
                minimized: Some(false),
            },
        ])
    }
    fn capture(&mut self, target: &Target, cancellation: &Cancellation) -> Result<Capture> {
        let current = self
            .targets(cancellation)?
            .into_iter()
            .find(|t| t.id == target.id)
            .ok_or_else(|| CuaError::new(ErrorCode::TargetNotFound, "Fixture target is gone."))?;
        if current.generation != target.generation {
            return Err(CuaError::new(
                ErrorCode::StaleTarget,
                "Fixture target was replaced.",
            ));
        }
        let width = current.pixel_width;
        let height = current.pixel_height;
        let mut rgba = vec![0; width as usize * height as usize * 4];
        for y in 0..height {
            cancellation.check()?;
            for x in 0..width {
                let index = (y as usize * width as usize + x as usize) * 4;
                let checker = ((x / 32 + y / 32) % 2) as u8;
                rgba[index..index + 4].copy_from_slice(&[
                    20 + checker * 12,
                    30 + checker * 12,
                    if current.kind == TargetKind::Monitor {
                        90
                    } else {
                        130
                    },
                    255,
                ]);
            }
        }
        Ok(Capture {
            target: current,
            raster: Raster {
                width,
                height,
                rgba,
            },
        })
    }
}

/// Until the native backend lands, default execution reports unavailable.
#[derive(Default)]
pub struct UnavailableBackend;

impl CaptureBackend for UnavailableBackend {
    fn name(&self) -> &'static str {
        "unavailable"
    }
    fn available(&self) -> bool {
        false
    }
    fn targets(&mut self, cancellation: &Cancellation) -> Result<Vec<Target>> {
        cancellation.check()?;
        Err(CuaError::new(
            ErrorCode::Unsupported,
            "Native CUA capture is not available in this build.",
        ))
    }
    fn capture(&mut self, _target: &Target, cancellation: &Cancellation) -> Result<Capture> {
        self.targets(cancellation)?;
        unreachable!("unavailable backend never supplies targets")
    }
}
