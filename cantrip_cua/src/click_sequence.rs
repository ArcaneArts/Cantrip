//! Compile compact click scores locally, before requesting any host input.
use crate::{
    error::{CuaError, ErrorCode, Result},
    gesture::{Modifier, MouseButton},
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Click {
    at_ms: u64,
    x: f64,
    y: f64,
    hold_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(crate) struct Options {
    hold_ms: u64,
    button: MouseButton,
    modifiers: Vec<Modifier>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            hold_ms: 50,
            button: MouseButton::Left,
            modifiers: Vec::new(),
        }
    }
}

fn invalid(message: impl Into<String>) -> CuaError {
    CuaError::new(ErrorCode::ScriptAction, message)
}

pub(crate) fn compile(clicks: Vec<Click>, options: Options) -> Result<Value> {
    if clicks.is_empty() || clicks.len() > 65536 {
        return Err(invalid(
            "clickSequence expects 1-65536 clicks (two timeline frames per click).",
        ));
    }
    if !crate::gesture::valid_modifiers(&options.modifiers) {
        return Err(invalid(
            "clickSequence modifiers must be unique Shift, Control, Alt or Meta values.",
        ));
    }
    let mut frames = Vec::with_capacity(clicks.len() * 2);
    let mut previous_release = 0;
    for (index, click) in clicks.into_iter().enumerate() {
        let hold = click.hold_ms.unwrap_or(options.hold_ms);
        let release = click.at_ms.checked_add(hold).filter(|end| *end <= 9_007_199_254_740_991)
            .ok_or_else(|| invalid(format!("clickSequence clicks[{index}]: atMs + holdMs must be a nonnegative safe-integer timestamp.")))?;
        if click.at_ms < previous_release {
            return Err(invalid(format!(
                "clickSequence clicks[{index}] overlaps the preceding click: atMs must be at least {previous_release}. Shorten holdMs or move this click later; clicks are never reordered or silently shortened."
            )));
        }
        if !click.x.is_finite() || !click.y.is_finite() || click.x < 0.0 || click.y < 0.0 {
            return Err(invalid(format!(
                "clickSequence clicks[{index}]: x and y must be finite nonnegative window-local coordinates."
            )));
        }
        let mut down = json!({"atMs":click.at_ms,"pointerDown":{"x":click.x,"y":click.y}});
        if options.button != MouseButton::Left {
            down["pointerButton"] = json!(options.button);
        }
        if !options.modifiers.is_empty() {
            down["pointerModifiers"] = json!(options.modifiers);
        }
        frames.push(down);
        frames.push(json!({"atMs":release,"pointerUp":true}));
        previous_release = release;
    }
    Ok(json!({"operation":"perform","command":{"kind":"timeline","frames":frames}}))
}
