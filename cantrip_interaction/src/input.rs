//! Backend-neutral input vocabulary. OS event codes belong to delivery adapters.
use crate::{
    error::{Result, ValidationError},
    geometry::Point,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Modifier {
    Shift,
    Control,
    Alt,
    Meta,
}
#[derive(
    Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash,
)]
#[serde(rename_all = "lowercase")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
    Back,
    Forward,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum MediaKey {
    PlayPause,
    NextTrack,
    PreviousTrack,
    FastForward,
    Rewind,
    VolumeUp,
    VolumeDown,
    VolumeMute,
}
pub fn valid_modifiers(modifiers: &[Modifier]) -> bool {
    modifiers.len() <= 4
        && modifiers
            .iter()
            .enumerate()
            .all(|(i, m)| !modifiers[..i].contains(m))
}
pub fn normalize_key(key: String) -> String {
    if key.len() == 1 && key.as_bytes()[0].is_ascii_lowercase() {
        key.to_ascii_uppercase()
    } else {
        key
    }
}
pub fn deserialize_key<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<String, D::Error> {
    String::deserialize(d).map(normalize_key)
}
pub fn deserialize_keys<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Vec<String>, D::Error> {
    Vec::<String>::deserialize(d).map(|keys| keys.into_iter().map(normalize_key).collect())
}

/// Declares the side-effect domain without conflating preparation with host focus.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputScope {
    Surface,
    HostFocus,
    System,
}

#[derive(Clone, Debug, PartialEq)]
pub enum TextInput {
    Commit(String),
    /// Selection is a UTF-16 range, matching native/browser composition APIs.
    Composition {
        text: String,
        selection_start: u32,
        selection_end: u32,
    },
    CancelComposition,
}

#[derive(Clone, Debug, PartialEq)]
pub enum InputEvent {
    PointerMove {
        point: Point,
        modifiers: Vec<Modifier>,
    },
    PointerDown {
        point: Point,
        button: MouseButton,
        modifiers: Vec<Modifier>,
    },
    PointerUp {
        point: Point,
        button: MouseButton,
    },
    KeyDown {
        key: String,
        modifiers: Vec<Modifier>,
        repeat: bool,
    },
    KeyUp {
        key: String,
    },
    Scroll {
        point: Point,
        delta_x: i32,
        delta_y: i32,
        modifiers: Vec<Modifier>,
    },
    Text(TextInput),
    PrepareSurface,
    RequestHostFocus,
    Media {
        key: MediaKey,
        modifiers: Vec<Modifier>,
    },
}
impl InputEvent {
    pub fn scope(&self) -> InputScope {
        match self {
            Self::RequestHostFocus => InputScope::HostFocus,
            Self::Media { .. } => InputScope::System,
            _ => InputScope::Surface,
        }
    }
    /// Structural validation only. Supported keys, composition, and delivery
    /// availability are decided by the backend attempting the real operation.
    pub fn validate(&self) -> Result<()> {
        let point = |p: &Point| p.x.is_finite() && p.y.is_finite() && p.x >= 0. && p.y >= 0.;
        let key = |s: &str| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control);
        let valid = match self {
            Self::PointerMove {
                point: p,
                modifiers,
            }
            | Self::PointerDown {
                point: p,
                modifiers,
                ..
            }
            | Self::Scroll {
                point: p,
                modifiers,
                ..
            } => point(p) && valid_modifiers(modifiers),
            Self::PointerUp { point: p, .. } => point(p),
            Self::KeyDown {
                key: k, modifiers, ..
            } => key(k) && valid_modifiers(modifiers),
            Self::KeyUp { key: k } => key(k),
            Self::Media { modifiers, .. } => valid_modifiers(modifiers),
            Self::Text(TextInput::Composition {
                text,
                selection_start,
                selection_end,
            }) => {
                selection_start <= selection_end
                    && (*selection_end as usize) <= text.encode_utf16().count()
            }
            _ => true,
        };
        if valid {
            Ok(())
        } else {
            Err(ValidationError::invalid("Invalid input event."))
        }
    }
}
