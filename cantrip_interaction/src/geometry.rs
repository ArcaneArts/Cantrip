//! Logical surface geometry. A surface need not be an operating-system window.
use crate::error::{Result, ValidationError};
use serde::{Deserialize, Serialize};
pub const MAX_IMAGE_PIXELS: usize = 4_194_304;
pub const MAX_SEQUENCE: u64 = (1 << 53) - 1;

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Bounds {
    pub fn validate(&self) -> Result<()> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .all(|n| n.is_finite())
            && self.width > 0.0
            && self.height > 0.0
        {
            Ok(())
        } else {
            Err(ValidationError::invalid("Invalid target bounds."))
        }
    }
    pub fn contains_local(&self, p: Point) -> bool {
        p.x.is_finite()
            && p.y.is_finite()
            && p.x >= 0.0
            && p.y >= 0.0
            && p.x < self.width
            && p.y < self.height
    }
    pub fn to_global(&self, point: Point) -> Result<Point> {
        self.validate()?;
        if !self.contains_local(point) {
            return Err(ValidationError::invalid("Cursor is outside target bounds."));
        }
        let global = Point {
            x: self.x + point.x,
            y: self.y + point.y,
        };
        if !global.x.is_finite() || !global.y.is_finite() {
            return Err(ValidationError::invalid("Global coordinates overflow."));
        }
        Ok(global)
    }
}

/// Newtypes prevent mixing captured pixels, viewport coordinates, and logical
/// input points in adapters. Bounds::to_global remains the compatibility API.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LogicalPoint(pub Point);
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImagePoint(pub Point);
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewportPoint(pub Point);
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlobalPoint(pub Point);

/// Construct this from the geometry associated with a particular frame. Image
/// dimensions may differ from native display scale after capture downsampling.
#[derive(Clone, Copy, Debug)]
pub struct Coordinates {
    pub logical_bounds: Bounds,
    pub image_width: u32,
    pub image_height: u32,
}
impl Coordinates {
    fn validate(&self) -> Result<()> {
        self.logical_bounds.validate()?;
        if self.image_width == 0 || self.image_height == 0 {
            return Err(ValidationError::invalid(
                "Image dimensions must be positive.",
            ));
        }
        Ok(())
    }
    pub fn image_to_logical(&self, point: ImagePoint) -> Result<LogicalPoint> {
        self.validate()?;
        let image = Bounds {
            x: 0.,
            y: 0.,
            width: self.image_width.into(),
            height: self.image_height.into(),
        };
        if !image.contains_local(point.0) {
            return Err(ValidationError::invalid(
                "Point is outside the captured image.",
            ));
        }
        Ok(LogicalPoint(Point {
            x: point.0.x / image.width * self.logical_bounds.width,
            y: point.0.y / image.height * self.logical_bounds.height,
        }))
    }
    pub fn logical_to_image(&self, point: LogicalPoint) -> Result<ImagePoint> {
        self.validate()?;
        if !self.logical_bounds.contains_local(point.0) {
            return Err(ValidationError::invalid("Point is outside logical bounds."));
        }
        Ok(ImagePoint(Point {
            x: point.0.x / self.logical_bounds.width * f64::from(self.image_width),
            y: point.0.y / self.logical_bounds.height * f64::from(self.image_height),
        }))
    }
    /// content is the fitted image rectangle in viewport coordinates, excluding
    /// letterboxing. An outside click is rejected instead of silently clamped.
    pub fn viewport_to_logical(
        &self,
        point: ViewportPoint,
        content: Bounds,
    ) -> Result<LogicalPoint> {
        self.validate()?;
        content.validate()?;
        let local = Point {
            x: point.0.x - content.x,
            y: point.0.y - content.y,
        };
        if !content.contains_local(local) {
            return Err(ValidationError::invalid(
                "Point is outside viewport content.",
            ));
        }
        Ok(LogicalPoint(Point {
            x: local.x / content.width * self.logical_bounds.width,
            y: local.y / content.height * self.logical_bounds.height,
        }))
    }
    pub fn logical_to_global(&self, point: LogicalPoint) -> Result<GlobalPoint> {
        self.logical_bounds.to_global(point.0).map(GlobalPoint)
    }
}
