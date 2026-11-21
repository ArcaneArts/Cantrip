use crate::term::BufWrite as _;

/// Represents a foreground or background color for cells.
#[derive(Eq, PartialEq, Debug, Copy, Clone, Default)]
pub enum Color {
    /// The default terminal color.
    #[default]
    Default,

    /// An indexed terminal color.
    Idx(u8),

    /// An RGB terminal color. The parameters are (red, green, blue).
    Rgb(u8, u8, u8),
}

const BOLD: u16 = 1 << 0;
const DIM: u16 = 1 << 1;
const ITALIC: u16 = 1 << 2;
const UNDERLINE: u16 = 1 << 3;
const INVERSE: u16 = 1 << 4;
const BLINK: u16 = 1 << 5;
const INVISIBLE: u16 = 1 << 6;
const STRIKETHROUGH: u16 = 1 << 7;
const OVERLINE: u16 = 1 << 8;
const INTENSITY: u16 = BOLD | DIM;
const RESET_INTENSITY: u8 = 22;

// Style bit and its SGR set and reset parameters, in replay order.
const STYLES: [(u16, u8, u8); 9] = [
    (BOLD, 1, RESET_INTENSITY),
    (DIM, 2, RESET_INTENSITY),
    (ITALIC, 3, 23),
    (UNDERLINE, 4, 24),
    (INVERSE, 7, 27),
    (BLINK, 5, 25),
    (INVISIBLE, 8, 28),
    (STRIKETHROUGH, 9, 29),
    (OVERLINE, 53, 55),
];

const COLOR_KIND_MASK: u8 = 0b11;
const BACKGROUND_KIND_SHIFT: u8 = 2;

#[derive(Default, Clone, Copy, PartialEq, Eq, Debug)]
pub struct Attrs {
    foreground: [u8; 3],
    background: [u8; 3],
    // Store the two color kinds together to leave room for additional
    // style flags without increasing the 32-byte Cell or shortening text.
    color_kinds: u8,
    mode: [u8; 2],
}

impl Attrs {
    pub fn fgcolor(&self) -> Color {
        decode_color(self.color_kinds & COLOR_KIND_MASK, self.foreground)
    }

    pub fn bgcolor(&self) -> Color {
        decode_color(
            self.color_kinds >> BACKGROUND_KIND_SHIFT,
            self.background,
        )
    }

    pub fn set_fgcolor(&mut self, color: Color) {
        let (kind, bytes) = encode_color(color);
        self.color_kinds = (self.color_kinds & !COLOR_KIND_MASK) | kind;
        self.foreground = bytes;
    }

    pub fn set_bgcolor(&mut self, color: Color) {
        let (kind, bytes) = encode_color(color);
        self.color_kinds = (self.color_kinds & COLOR_KIND_MASK)
            | (kind << BACKGROUND_KIND_SHIFT);
        self.background = bytes;
    }

    fn mode(&self) -> u16 {
        u16::from_le_bytes(self.mode)
    }

    pub fn bold(&self) -> bool {
        self.mode() & BOLD != 0
    }

    pub fn dim(&self) -> bool {
        self.mode() & DIM != 0
    }

    pub fn italic(&self) -> bool {
        self.mode() & ITALIC != 0
    }

    pub fn underline(&self) -> bool {
        self.mode() & UNDERLINE != 0
    }

    pub fn inverse(&self) -> bool {
        self.mode() & INVERSE != 0
    }

    pub fn set_underline(&mut self, enabled: bool) {
        self.set_style(UNDERLINE, enabled);
    }

    fn set_style(&mut self, style: u16, enabled: bool) {
        let old = self.mode();
        self.mode =
            if enabled { old | style } else { old & !style }.to_le_bytes();
    }

    pub fn apply_style(&mut self, param: u16) -> bool {
        if param == u16::from(RESET_INTENSITY) {
            self.set_style(INTENSITY, false);
            return true;
        }
        for (style, on, off) in STYLES {
            if param == u16::from(on) || param == u16::from(off) {
                self.set_style(style, param == u16::from(on));
                return true;
            }
        }
        false
    }

    pub fn write_escape_code_diff(
        &self,
        contents: &mut Vec<u8>,
        other: &Self,
    ) {
        if self == other {
            return;
        }
        if *self == Self::default() {
            crate::term::ClearAttrs.write_buf(contents);
            return;
        }

        // SGR 22 clears both intensity flags. Keep either flag that
        // remains set by writing it again after the shared reset.
        let mode = self.mode();
        let previous_mode = other.mode();
        let reset_intensity = previous_mode & !mode & INTENSITY != 0;
        let previous = if reset_intensity {
            previous_mode & !INTENSITY
        } else {
            previous_mode
        };
        let changes =
            STYLES.into_iter().filter_map(|(style, on, off)| {
                ((mode ^ previous) & style != 0)
                    .then_some(if mode & style != 0 { on } else { off })
            });
        let style_params = reset_intensity
            .then_some(RESET_INTENSITY)
            .into_iter()
            .chain(changes);
        crate::term::write_attrs(
            contents,
            (self.fgcolor() != other.fgcolor()).then(|| self.fgcolor()),
            (self.bgcolor() != other.bgcolor()).then(|| self.bgcolor()),
            style_params,
        );
    }
}

fn encode_color(color: Color) -> (u8, [u8; 3]) {
    match color {
        Color::Default => (0, [0; 3]),
        Color::Idx(i) => (1, [i, 0, 0]),
        Color::Rgb(r, g, b) => (2, [r, g, b]),
    }
}

fn decode_color(kind: u8, [r, g, b]: [u8; 3]) -> Color {
    match kind {
        0 => Color::Default,
        1 => Color::Idx(r),
        2 => Color::Rgb(r, g, b),
        _ => unreachable!(),
    }
}
