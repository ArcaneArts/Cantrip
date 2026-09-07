//! Logical agent cursor state and straight-alpha RGBA rendering. This module
//! never moves the operating-system pointer. Labels use font8x8's Latin, Greek,
//! Hiragana, box/block and miscellaneous Unicode tables; unsupported characters
//! render as a visible replacement box. Full shaping, combining marks, emoji,
//! bidirectional layout and arbitrary cursor assets are not implemented.

use crate::error::{CuaError, Result};
use crate::target::{Bounds, MAX_IMAGE_PIXELS, MAX_SEQUENCE, Point};
use font8x8::UnicodeFonts;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

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
        self.render_region(
            rgba,
            pixel_width,
            pixel_height,
            bounds,
            &Bounds {
                x: 0.0,
                y: 0.0,
                width: bounds.width,
                height: bounds.height,
            },
        )
    }

    /// Render a target-local viewport without changing cursor or label geometry.
    pub fn render_region(
        &self,
        rgba: &mut [u8],
        pixel_width: u32,
        pixel_height: u32,
        bounds: &Bounds,
        region: &Bounds,
    ) -> Result<()> {
        region.validate()?;
        if region.x < 0.0
            || region.y < 0.0
            || region.x + region.width > bounds.width
            || region.y + region.height > bounds.height
        {
            return Err(CuaError::invalid(
                "Cursor viewport is outside target bounds.",
            ));
        }
        let mut canvas = Canvas::new(rgba, pixel_width, pixel_height, region)?;
        canvas.origin = Point {
            x: region.x,
            y: region.y,
        };
        self.draw(&mut canvas, bounds)
    }

    /// Sparse, non-overlapping desktop tiles touched by the same drawing commands.
    /// Empty space between trail points never requires a window-sized raster.
    pub fn desktop_tiles(&self, bounds: &Bounds) -> Result<Vec<Bounds>> {
        bounds.validate()?;
        let mut canvas = Canvas {
            rgba: &mut [],
            width: bounds.width.ceil() as u32,
            height: bounds.height.ceil() as u32,
            scale_x: 1.0,
            scale_y: 1.0,
            origin: Point::default(),
            tiles: Some(BTreeSet::new()),
        };
        self.draw(&mut canvas, bounds)?;
        Ok(canvas
            .tiles
            .unwrap()
            .into_iter()
            .map(|(x, y)| {
                let x = f64::from(x * DESKTOP_TILE_SIZE);
                let y = f64::from(y * DESKTOP_TILE_SIZE);
                Bounds {
                    x,
                    y,
                    width: (bounds.width - x).min(f64::from(DESKTOP_TILE_SIZE)),
                    height: (bounds.height - y).min(f64::from(DESKTOP_TILE_SIZE)),
                }
            })
            .collect())
    }

    fn draw(&self, canvas: &mut Canvas<'_>, bounds: &Bounds) -> Result<()> {
        self.appearance.validate()?;
        bounds.validate()?;
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
        let glow = self.glow_strength();
        if glow > 0 {
            canvas.glow(self.position, self.appearance.style, size, color, glow);
        }
        canvas.shape(self.position, self.appearance.style, size, color);
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
    origin: Point,
    tiles: Option<BTreeSet<(u32, u32)>>,
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
            origin: Point::default(),
            tiles: None,
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
        let left = ((left - self.origin.x) * self.scale_x)
            .floor()
            .clamp(0.0, f64::from(self.width)) as u32;
        let right = ((right - self.origin.x) * self.scale_x)
            .ceil()
            .clamp(0.0, f64::from(self.width)) as u32;
        let top = ((top - self.origin.y) * self.scale_y)
            .floor()
            .clamp(0.0, f64::from(self.height)) as u32;
        let bottom = ((bottom - self.origin.y) * self.scale_y)
            .ceil()
            .clamp(0.0, f64::from(self.height)) as u32;
        if let Some(tiles) = &mut self.tiles {
            if left < right && top < bottom {
                for y in top / DESKTOP_TILE_SIZE..=(bottom - 1) / DESKTOP_TILE_SIZE {
                    for x in left / DESKTOP_TILE_SIZE..=(right - 1) / DESKTOP_TILE_SIZE {
                        tiles.insert((x, y));
                    }
                }
            }
            return;
        }
        for y in top..bottom {
            let logical_y = (f64::from(y) + 0.5) / self.scale_y + self.origin.y;
            for x in left..right {
                let logical_x = (f64::from(x) + 0.5) / self.scale_x + self.origin.x;
                if let Some(color) = color_at(logical_x, logical_y) {
                    let index = (y as usize * self.width as usize + x as usize) * 4;
                    blend(&mut self.rgba[index..index + 4], color);
                }
            }
        }
    }

    fn glow(&mut self, point: Point, style: CursorStyle, size: f64, color: [u8; 4], strength: u8) {
        // Extend the halo beyond the silhouette by more than one cursor length.
        let spread = size * 1.35;
        let (left, top, right, bottom) = if style == CursorStyle::Arrow {
            (
                point.x - spread,
                point.y - spread,
                point.x + size + spread,
                point.y + size + spread,
            )
        } else {
            let radius = size / 2.0 + spread;
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
            let distance = if style == CursorStyle::Arrow {
                arrow_distance(x / size, y / size) * size
            } else {
                (x * x + y * y).sqrt() - size / 2.0
            };
            let falloff = (1.0 - distance.max(0.0) / spread).clamp(0.0, 1.0);
            let alpha =
                (f64::from(color[3]) * f64::from(strength) / 255.0 * 0.48 * falloff * falloff)
                    .round() as u8;
            (alpha > 0).then_some([color[0], color[1], color[2], alpha])
        });
    }

    fn shape(&mut self, point: Point, style: CursorStyle, size: f64, color: [u8; 4]) {
        if style == CursorStyle::Arrow {
            // Signed-distance edge gives a thin light keyline and soft dark
            // outside edge, remaining readable on both light and dark content.
            let aa = (0.65 / self.scale_x.min(self.scale_y)).min(1.0);
            let border = (size / 24.0).clamp(0.7, 1.5);
            self.paint(
                point.x - 3.0,
                point.y - 3.0,
                point.x + size + 3.0,
                point.y + size + 3.0,
                |x, y| {
                    let d = arrow_distance((x - point.x) / size, (y - point.y) / size) * size;
                    if d > border + aa + 1.0 {
                        return None;
                    }
                    let (rgb, opacity) = if d < -border {
                        ([color[0], color[1], color[2]], 1.0)
                    } else if d <= 0.0 {
                        let edge = ((d + border) / border).clamp(0.0, 1.0);
                        (
                            [color[0], color[1], color[2]].map(|v| {
                                (f64::from(v) * (1.0 - edge) + 245.0 * edge).round() as u8
                            }),
                            1.0,
                        )
                    } else {
                        (
                            [18, 23, 32],
                            (1.0 - d / (border + aa + 1.0)).clamp(0.0, 1.0) * 0.65,
                        )
                    };
                    Some([
                        rgb[0],
                        rgb[1],
                        rgb[2],
                        (f64::from(color[3]) * opacity).round() as u8,
                    ])
                },
            );
            return;
        }

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

const ARROW_POINTS: [(f64, f64); 4] = [(0.0, 0.0), (0.24, 0.92), (0.44, 0.48), (0.88, 0.30)];

fn arrow_distance(x: f64, y: f64) -> f64 {
    let mut distance = f64::INFINITY;
    for i in 0..ARROW_POINTS.len() {
        let a = ARROW_POINTS[i];
        let b = ARROW_POINTS[(i + 1) % ARROW_POINTS.len()];
        let dx = b.0 - a.0;
        let dy = b.1 - a.1;
        let t = ((x - a.0) * dx + (y - a.1) * dy) / (dx * dx + dy * dy);
        distance = distance
            .min((x - a.0 - t.clamp(0.0, 1.0) * dx).hypot(y - a.1 - t.clamp(0.0, 1.0) * dy));
    }
    if inside_arrow(x, y) {
        -distance
    } else {
        distance
    }
}

fn inside_arrow(x: f64, y: f64) -> bool {
    const POINTS: [(f64, f64); 4] = ARROW_POINTS;
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
