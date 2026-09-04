use crate::error::{CuaError, Result};
use serde::{Deserialize, Serialize};

pub const MAX_IMAGE_PIXELS: usize = 4_194_304;

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
            Err(CuaError::invalid("Invalid target bounds."))
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
            return Err(CuaError::invalid("Cursor is outside target bounds."));
        }
        let global = Point {
            x: self.x + point.x,
            y: self.y + point.y,
        };
        if !global.x.is_finite() || !global.y.is_finite() {
            return Err(CuaError::invalid("Global coordinates overflow."));
        }
        Ok(global)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    Monitor,
    Window,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub id: String,
    pub generation: u64,
    pub kind: TargetKind,
    pub title: Option<String>,
    pub application: Option<String>,
    pub process_id: Option<u32>,
    pub bounds: Bounds,
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub scale_factor: f64,
    pub focused: Option<bool>,
    pub minimized: Option<bool>,
}

impl Target {
    pub fn validate(&self) -> Result<()> {
        self.bounds.validate()?;
        validate_id(&self.id)?;
        if self.generation == 0
            || self.generation > MAX_SEQUENCE
            || !self.scale_factor.is_finite()
            || self.scale_factor <= 0.0
            || self.pixel_width == 0
            || self.pixel_height == 0
            || self.title.as_ref().is_some_and(|s| s.len() > 4096)
            || self.application.as_ref().is_some_and(|s| s.len() > 1024)
        {
            return Err(CuaError::invalid("Invalid target metadata."));
        }
        Ok(())
    }
}

pub const MAX_SEQUENCE: u64 = (1 << 53) - 1;

pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        Err(CuaError::invalid("Invalid opaque identifier."))
    } else {
        Ok(())
    }
}
