//! Logical participant cursor state. Rasterization is in the rendering module. This module
//! never moves the operating-system pointer. Labels use font8x8's Latin, Greek,
//! Hiragana, box/block and miscellaneous Unicode tables; unsupported characters
//! render as a visible replacement box. Full shaping, combining marks, emoji,
//! bidirectional layout and arbitrary cursor assets are not implemented.

use crate::error::{Result, ValidationError};
use crate::geometry::{Bounds, MAX_SEQUENCE, Point};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const DESKTOP_TILE_SIZE: u32 = 256;
pub const CLICK_GLOW_MS: u64 = 240;

pub const CURSOR_APPEARANCE_VERSION: u8 = 1;
pub const MAX_TRAIL_POINTS: usize = 24;
pub const MIN_CURSOR_SIZE: u16 = 8;
pub const MAX_CURSOR_SIZE: u16 = 96;
pub const MAX_LABEL_CHARACTERS: usize = 64;
pub const MAX_LABEL_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CursorStyle {
    #[default]
    Arrow,
    Dot,
    Ring,
    Crosshair,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct CursorAppearance {
    pub version: u8,
    pub style: CursorStyle,
    pub color: String,
    /// Overall cursor size in target-local logical units, independent of DPI.
    pub size: u16,
    pub label: Option<String>,
    pub trail: bool,
    pub visible: bool,
}

impl Default for CursorAppearance {
    fn default() -> Self {
        Self {
            version: CURSOR_APPEARANCE_VERSION,
            style: CursorStyle::Arrow,
            color: "#20BFA9".into(),
            size: 24,
            label: None,
            trail: false,
            visible: true,
        }
    }
}

impl CursorAppearance {
    /// Rotate only the default hue. Min/max channels (and therefore HSV value
    /// and saturation / HSL lightness) stay fixed; identity never leaves the hash.
    pub fn for_identity(identity: &str) -> Self {
        let mut appearance = Self::default();
        let base = appearance.rgba().expect("valid default cursor color");
        let low = f64::from(*base[..3].iter().min().unwrap());
        let high = f64::from(*base[..3].iter().max().unwrap());
        let digest = Sha256::digest(identity.as_bytes());
        let hue =
            f64::from(u32::from_be_bytes(digest[..4].try_into().unwrap())) / 4_294_967_296.0 * 6.0;
        let chroma = high - low;
        let x = chroma * (1.0 - (hue % 2.0 - 1.0).abs());
        let rgb = match hue as u8 {
            0 => [chroma, x, 0.0],
            1 => [x, chroma, 0.0],
            2 => [0.0, chroma, x],
            3 => [0.0, x, chroma],
            4 => [x, 0.0, chroma],
            _ => [chroma, 0.0, x],
        }
        .map(|v| (v + low).round() as u8);
        appearance.color = format!("#{:02X}{:02X}{:02X}", rgb[0], rgb[1], rgb[2]);
        appearance
    }

    pub fn validate(&self) -> Result<()> {
        if self.version != CURSOR_APPEARANCE_VERSION
            || !(MIN_CURSOR_SIZE..=MAX_CURSOR_SIZE).contains(&self.size)
        {
            return Err(ValidationError::invalid(
                "Unsupported cursor appearance version or size.",
            ));
        }
        self.rgba()?;
        if self.label.as_ref().is_some_and(|label| {
            label.len() > MAX_LABEL_BYTES
                || label.chars().count() > MAX_LABEL_CHARACTERS
                || label.chars().any(char::is_control)
        }) {
            return Err(ValidationError::invalid(
                "Cursor label exceeds its limit or contains control characters.",
            ));
        }
        Ok(())
    }

    pub fn rgba(&self) -> Result<[u8; 4]> {
        let bytes = self.color.as_bytes();
        if !matches!(bytes.len(), 7 | 9)
            || bytes[0] != b'#'
            || !bytes[1..].iter().all(u8::is_ascii_hexdigit)
        {
            return Err(ValidationError::invalid(
                "Cursor color must be #RRGGBB or #RRGGBBAA.",
            ));
        }
        let nibble = |byte: u8| match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            _ => unreachable!("color was validated above"),
        };
        let mut color = [0, 0, 0, 255];
        for (channel, pair) in bytes[1..].chunks_exact(2).enumerate() {
            color[channel] = nibble(pair[0]) * 16 + nibble(pair[1]);
        }
        Ok(color)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CursorState {
    pub appearance: CursorAppearance,
    pub position: Point,
    pub trail_points: Vec<Point>,
    pub updated_at_ms: u64,
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<CursorAction>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CursorAction {
    pub method: String,
    pub outcome: String,
    pub at_ms: u64,
}

impl Default for CursorState {
    fn default() -> Self {
        Self {
            appearance: CursorAppearance::default(),
            position: Point::default(),
            trail_points: Vec::new(),
            updated_at_ms: 0,
            revision: 1,
            action: None,
        }
    }
}

impl CursorState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Advance presentation time without changing the retained input receipt.
    pub fn presentation(&self, now: u64) -> Self {
        let mut result = self.clone();
        result.updated_at_ms = result.updated_at_ms.max(now);
        result
    }

    pub fn glow_strength(&self) -> u8 {
        let Some(action) = &self.action else {
            return 0;
        };
        if !matches!(action.outcome.as_str(), "unknown" | "dispatched") {
            return 0;
        }
        let age = self.updated_at_ms.saturating_sub(action.at_ms);
        let remaining = 1.0 - age.min(CLICK_GLOW_MS) as f64 / CLICK_GLOW_MS as f64;
        (255.0 * remaining * remaining).round() as u8
    }

    pub fn configure(&mut self, appearance: CursorAppearance, now: u64) -> Result<()> {
        appearance.validate()?;
        let revision = self.next_revision(now)?;
        if !appearance.trail || !self.appearance.trail {
            self.trail_points.clear();
        }
        self.appearance = appearance;
        self.updated_at_ms = self.updated_at_ms.max(now);
        self.revision = revision;
        Ok(())
    }

    pub fn move_to(&mut self, position: Point, bounds: &Bounds, now: u64) -> Result<()> {
        bounds.validate()?;
        if !bounds.contains_local(position) {
            return Err(ValidationError::invalid("Cursor is outside target bounds."));
        }
        let revision = self.next_revision(now)?;
        if self.appearance.trail && self.position != position {
            if self.trail_points.len() >= MAX_TRAIL_POINTS {
                self.trail_points
                    .drain(..self.trail_points.len() - MAX_TRAIL_POINTS + 1);
            }
            self.trail_points.push(self.position);
        }
        self.action = None;
        self.position = position;
        self.updated_at_ms = self.updated_at_ms.max(now);
        self.revision = revision;
        Ok(())
    }

    pub fn mark_action(&mut self, method: &str, outcome: &str, now: u64) {
        self.action = Some(CursorAction {
            method: method.into(),
            outcome: outcome.into(),
            at_ms: now,
        });
        // Presentation bookkeeping must not fail after input was attempted.
        self.updated_at_ms = self.updated_at_ms.max(now);
        self.revision = self.revision.saturating_add(1).min(MAX_SEQUENCE);
    }

    pub fn clear_action(&mut self, now: u64) {
        if self.action.take().is_some() {
            self.updated_at_ms = self.updated_at_ms.max(now);
            self.revision = self.revision.saturating_add(1).min(MAX_SEQUENCE);
        }
    }

    fn next_revision(&self, now: u64) -> Result<u64> {
        if now > MAX_SEQUENCE || self.revision >= MAX_SEQUENCE {
            return Err(ValidationError::invalid(
                "Cursor timestamp or revision is outside the supported range.",
            ));
        }
        Ok(self.revision + 1)
    }
}
