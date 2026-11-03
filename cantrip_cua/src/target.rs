use crate::error::{CuaError, Result};
use serde::{Deserialize, Serialize};

pub use cantrip_interaction::geometry::{Bounds, MAX_IMAGE_PIXELS, MAX_SEQUENCE, Point};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetKind {
    Monitor,
    Window,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DenialReason {
    CantripAppProtected,
    DisplayMayIncludeCantrip,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetAccess {
    pub allowed: bool,
    pub reason: Option<DenialReason>,
}

pub(crate) fn is_cantrip_application_name(name: &str) -> bool {
    ["Cantrip", "Cantrip Dev", "cantrip-app", "cantrip_app"]
        .iter()
        .any(|candidate| name.eq_ignore_ascii_case(candidate))
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<TargetAccess>,
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

pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        Err(CuaError::invalid("Invalid opaque identifier."))
    } else {
        Ok(())
    }
}

impl cantrip_interaction::presentation::CursorTarget for Target {
    fn id(&self) -> &str {
        &self.id
    }
    fn generation(&self) -> u64 {
        self.generation
    }
    fn bounds(&self) -> Bounds {
        self.bounds
    }
    fn scale_factor(&self) -> f64 {
        self.scale_factor
    }
}
