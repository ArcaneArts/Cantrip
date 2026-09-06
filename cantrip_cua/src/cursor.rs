//! Logical agent cursor state and straight-alpha RGBA rendering. This module
//! never moves the operating-system pointer. Labels use font8x8's Latin, Greek,
//! Hiragana, box/block and miscellaneous Unicode tables; unsupported characters
//! render as a visible replacement box. Full shaping, combining marks, emoji,
//! bidirectional layout and arbitrary cursor assets are not implemented.

use crate::error::{CuaError, Result};
use crate::target::{Bounds, MAX_IMAGE_PIXELS, MAX_SEQUENCE, Point};
use font8x8::UnicodeFonts;
use serde::{Deserialize, Serialize};

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
    pub fn validate(&self) -> Result<()> {
        if self.version != CURSOR_APPEARANCE_VERSION
            || !(MIN_CURSOR_SIZE..=MAX_CURSOR_SIZE).contains(&self.size)
        {
            return Err(CuaError::invalid(
                "Unsupported cursor appearance version or size.",
            ));
        }
        self.rgba()?;
        if self.label.as_ref().is_some_and(|label| {
            label.len() > MAX_LABEL_BYTES
                || label.chars().count() > MAX_LABEL_CHARACTERS
                || label.chars().any(char::is_control)
        }) {
            return Err(CuaError::invalid(
                "Cursor label exceeds its limit or contains control characters.",
            ));
        }
        Ok(())
    }

    fn rgba(&self) -> Result<[u8; 4]> {
        let bytes = self.color.as_bytes();
        if !matches!(bytes.len(), 7 | 9)
            || bytes[0] != b'#'
            || !bytes[1..].iter().all(u8::is_ascii_hexdigit)
        {
            return Err(CuaError::invalid(
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
            return Err(CuaError::invalid("Cursor is outside target bounds."));
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

    pub fn mark_action(&mut self, method: &str, now: u64) {
        self.action = Some(CursorAction {
            method: method.into(),
            outcome: "dispatched".into(),
            at_ms: now,
        });
    }

    fn next_revision(&self, now: u64) -> Result<u64> {
        if now > MAX_SEQUENCE || self.revision >= MAX_SEQUENCE {
            return Err(CuaError::invalid(
                "Cursor timestamp or revision is outside the supported range.",
            ));
        }
        Ok(self.revision + 1)
    }

    /// Composite the cursor onto straight-alpha RGBA bytes using target-local
    /// coordinates. The global origin of `bounds` never shifts the cursor.
    pub fn render(
        &self,
        rgba: &mut [u8],
        pixel_width: u32,
        pixel_height: u32,
        bounds: &Bounds,
    ) -> Result<()> {
        self.appearance.validate()?;
        bounds.validate()?;
        let mut canvas = Canvas::new(rgba, pixel_width, pixel_height, bounds)?;
        if !bounds.contains_local(self.position)
            || self.trail_points.len() > MAX_TRAIL_POINTS
            || self
                .trail_points
                .iter()
                .any(|point| !bounds.contains_local(*point))
        {
            return Err(CuaError::invalid(
                "Invalid logical cursor position or trail.",
            ));
        }
        if !self.appearance.visible {
            return Ok(());
        }
        let color = self.appearance.rgba()?;
        if color[3] == 0 {
            return Ok(());
        }
        let size = f64::from(self.appearance.size);
        if self.appearance.trail {
            for (index, position) in self.trail_points.iter().enumerate() {
                let mut trail_color = color;
                trail_color[3] = (u32::from(color[3]) * (index as u32 + 1)
                    / (2 * self.trail_points.len() as u32 + 1))
                    as u8;
                canvas.shape(
                    *position,
                    CursorStyle::Dot,
                    (size / 5.0).max(2.0),
                    trail_color,
                );
            }
        }
        canvas.shape(self.position, self.appearance.style, size, color);
        if self.action.is_some() {
            canvas.shape(
                self.position,
                CursorStyle::Ring,
                (size * 1.5).min(144.0),
                color,
            );
            canvas.shape(self.position, CursorStyle::Dot, 4.0, color);
        }
        if let Some(label) = &self.appearance.label {
            canvas.label(self.position, size, label, color, bounds);
        }
        Ok(())
    }
}

struct Canvas<'a> {
    rgba: &'a mut [u8],
    width: u32,
    height: u32,
    scale_x: f64,
    scale_y: f64,
}

impl<'a> Canvas<'a> {
    fn new(rgba: &'a mut [u8], width: u32, height: u32, bounds: &Bounds) -> Result<Self> {
        let pixels = (width as usize)
            .checked_mul(height as usize)
            .filter(|pixels| *pixels > 0 && *pixels <= MAX_IMAGE_PIXELS)
            .ok_or_else(|| CuaError::invalid("Invalid cursor image dimensions."))?;
        if rgba.len() != pixels * 4 {
            return Err(CuaError::invalid(
                "Cursor image byte length does not match its dimensions.",
            ));
        }
        let scale_x = f64::from(width) / bounds.width;
        let scale_y = f64::from(height) / bounds.height;
        if !scale_x.is_finite() || !scale_y.is_finite() || scale_x <= 0.0 || scale_y <= 0.0 {
            return Err(CuaError::invalid("Invalid cursor image scale."));
        }
        Ok(Self {
            rgba,
            width,
            height,
            scale_x,
            scale_y,
        })
    }

    fn paint(
        &mut self,
        left: f64,
        top: f64,
        right: f64,
        bottom: f64,
        mut color_at: impl FnMut(f64, f64) -> Option<[u8; 4]>,
    ) {
        let left = (left * self.scale_x)
            .floor()
            .clamp(0.0, f64::from(self.width)) as u32;
        let right = (right * self.scale_x)
            .ceil()
            .clamp(0.0, f64::from(self.width)) as u32;
        let top = (top * self.scale_y)
            .floor()
            .clamp(0.0, f64::from(self.height)) as u32;
        let bottom = (bottom * self.scale_y)
            .ceil()
            .clamp(0.0, f64::from(self.height)) as u32;
        for y in top..bottom {
            let logical_y = (f64::from(y) + 0.5) / self.scale_y;
            for x in left..right {
                let logical_x = (f64::from(x) + 0.5) / self.scale_x;
                if let Some(color) = color_at(logical_x, logical_y) {
                    let index = (y as usize * self.width as usize + x as usize) * 4;
                    blend(&mut self.rgba[index..index + 4], color);
                }
            }
        }
    }

    fn shape(&mut self, point: Point, style: CursorStyle, size: f64, color: [u8; 4]) {
        let radius = size / 2.0;
        let (left, top, right, bottom) = if style == CursorStyle::Arrow {
            (point.x, point.y, point.x + size, point.y + size)
        } else {
            (
                point.x - radius,
                point.y - radius,
                point.x + radius,
                point.y + radius,
            )
        };
        self.paint(left, top, right, bottom, |x, y| {
            let x = x - point.x;
            let y = y - point.y;
            let inside = match style {
                CursorStyle::Arrow => inside_arrow(x / size, y / size),
                CursorStyle::Dot => x * x + y * y <= radius * radius,
                CursorStyle::Ring => {
                    let squared = x * x + y * y;
                    let inner = radius - (size / 10.0).max(1.5);
                    squared <= radius * radius && squared >= inner * inner
                }
                CursorStyle::Crosshair => {
                    let half_stroke = (size / 12.0).max(1.5) / 2.0;
                    x.abs() <= radius
                        && y.abs() <= radius
                        && (x.abs() <= half_stroke || y.abs() <= half_stroke)
                }
            };
            inside.then_some(color)
        });
    }

    fn label(&mut self, point: Point, size: f64, text: &str, color: [u8; 4], bounds: &Bounds) {
        if text.is_empty() {
            return;
        }
        let glyphs: Vec<_> = text.chars().map(glyph).collect();
        let font_scale = (size / 24.0).clamp(1.0, 2.0);
        let width = glyphs.len() as f64 * 8.0 * font_scale;
        let height = 8.0 * font_scale;
        let x = (point.x + size + 4.0).min((bounds.width - width - 4.0).max(2.0));
        let y = point.y.min((bounds.height - height - 4.0).max(2.0));
        self.paint(
            x - 2.0,
            y - 2.0,
            x + width + 2.0,
            y + height + 2.0,
            |_, _| Some([0, 0, 0, (u16::from(color[3]) * 3 / 4) as u8]),
        );
        self.paint(x, y, x + width, y + height, |logical_x, logical_y| {
            let column = ((logical_x - x) / font_scale).floor() as usize;
            let row = ((logical_y - y) / font_scale).floor() as usize;
            glyphs.get(column / 8).and_then(|glyph| {
                glyph
                    .get(row)
                    .and_then(|bits| (bits & (1 << (column % 8)) != 0).then_some(color))
            })
        });
    }
}

fn inside_arrow(x: f64, y: f64) -> bool {
    const POINTS: [(f64, f64); 7] = [
        (0.0, 0.0),
        (0.0, 1.0),
        (0.26, 0.74),
        (0.47, 1.0),
        (0.64, 0.90),
        (0.42, 0.64),
        (0.81, 0.62),
    ];
    let mut inside = false;
    let mut previous = POINTS[POINTS.len() - 1];
    for current in POINTS {
        if (current.1 > y) != (previous.1 > y)
            && x < (previous.0 - current.0) * (y - current.1) / (previous.1 - current.1) + current.0
        {
            inside = !inside;
        }
        previous = current;
    }
    inside
}

fn glyph(character: char) -> [u8; 8] {
    font8x8::BASIC_FONTS
        .get(character)
        .or_else(|| font8x8::LATIN_FONTS.get(character))
        .or_else(|| font8x8::GREEK_FONTS.get(character))
        .or_else(|| font8x8::HIRAGANA_FONTS.get(character))
        .or_else(|| font8x8::BOX_FONTS.get(character))
        .or_else(|| font8x8::BLOCK_FONTS.get(character))
        .or_else(|| font8x8::MISC_FONTS.get(character))
        .unwrap_or([0x7e, 0x42, 0x5a, 0x5a, 0x5a, 0x42, 0x7e, 0x00])
}

/// Porter-Duff source-over on straight (not premultiplied) RGBA channels.
fn blend(destination: &mut [u8], source: [u8; 4]) {
    let source_alpha = u32::from(source[3]);
    if source_alpha == 0 {
        return;
    }
    let destination_alpha = u32::from(destination[3]);
    let inverse_alpha = 255 - source_alpha;
    let combined_alpha = source_alpha * 255 + destination_alpha * inverse_alpha;
    for index in 0..3 {
        let channel = u32::from(source[index]) * source_alpha * 255
            + u32::from(destination[index]) * destination_alpha * inverse_alpha;
        destination[index] = ((channel + combined_alpha / 2) / combined_alpha) as u8;
    }
    destination[3] = ((combined_alpha + 127) / 255) as u8;
}
