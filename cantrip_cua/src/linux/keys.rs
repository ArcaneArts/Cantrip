use crate::gesture::{Modifier, MouseButton};

pub(super) fn button(button: MouseButton) -> u8 {
    match button {
        MouseButton::Left => 1,
        MouseButton::Middle => 2,
        MouseButton::Right => 3,
        MouseButton::Back => 8,
        MouseButton::Forward => 9,
    }
}
pub(super) fn modifier(modifier: Modifier) -> u32 {
    match modifier {
        Modifier::Shift => 0xffe1,
        Modifier::Control => 0xffe3,
        Modifier::Alt => 0xffe9,
        Modifier::Meta => 0xffeb,
    }
}
pub(super) fn symbol(key: &str) -> Option<u32> {
    Some(match key {
        "Shift" | "ShiftLeft" => 0xffe1,
        "ShiftRight" => 0xffe2,
        "Control" | "ControlLeft" => 0xffe3,
        "ControlRight" => 0xffe4,
        "Alt" | "AltLeft" => 0xffe9,
        "AltRight" => 0xffea,
        "Meta" | "MetaLeft" => 0xffeb,
        "MetaRight" => 0xffec,
        "Enter" | "Return" => 0xff0d,
        "Tab" => 0xff09,
        "Space" | " " => 0x20,
        "Escape" | "Esc" => 0xff1b,
        "Backspace" => 0xff08,
        "Delete" => 0xffff,
        "ArrowLeft" | "Left" => 0xff51,
        "ArrowUp" | "Up" => 0xff52,
        "ArrowRight" | "Right" => 0xff53,
        "ArrowDown" | "Down" => 0xff54,
        "Home" => 0xff50,
        "End" => 0xff57,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        "Insert" => 0xff63,
        "CapsLock" => 0xffe5,
        k if k.starts_with('F') && k[1..].parse::<u32>().is_ok_and(|n| (1..=20).contains(&n)) => {
            0xffbd + k[1..].parse::<u32>().ok()?
        }
        k if k.chars().count() == 1 => k.to_ascii_lowercase().chars().next()? as u32,
        _ => return None,
    })
}

use super::failure;
use crate::error::{CuaError, ErrorCode, Result};
use std::{collections::BTreeMap, sync::Arc};
use x11rb::{
    connection::Connection,
    protocol::xproto::{ConnectionExt, KeyButMask},
    rust_connection::RustConnection,
};

/// A Unicode mapping stays stable for this connection. Restoring/reusing one
/// keycode between characters races clients that refresh XKB maps asynchronously.
/// Existing layout mappings are used directly; only empty slots are allocated.
pub(super) struct Keyboard {
    connection: Arc<RustConnection>,
    temporary: BTreeMap<u8, (u32, u8, Vec<u32>)>,
}
impl Keyboard {
    pub(super) fn new(connection: Arc<RustConnection>) -> Self {
        Self {
            connection,
            temporary: BTreeMap::new(),
        }
    }
    pub(super) fn resolve(&mut self, symbol: u32) -> Result<(u8, bool)> {
        let setup = self.connection.setup();
        let map = self
            .connection
            .get_keyboard_mapping(setup.min_keycode, setup.max_keycode - setup.min_keycode + 1)
            .map_err(failure)?
            .reply()
            .map_err(failure)?;
        let width = map.keysyms_per_keycode as usize;
        for (index, row) in map.keysyms.chunks(width).enumerate() {
            if let Some(level) = row.iter().take(2).position(|key| *key == symbol) {
                let mut shift = level == 1;
                if char::from_u32(symbol).is_some_and(|c| c.is_ascii_alphabetic()) {
                    let pointer = self
                        .connection
                        .query_pointer(setup.roots[0].root)
                        .map_err(failure)?
                        .reply()
                        .map_err(failure)?;
                    if pointer.mask.contains(KeyButMask::LOCK) {
                        shift = !shift;
                    }
                }
                return Ok((setup.min_keycode + index as u8, shift));
            }
        }
        let (index, row) = map
            .keysyms
            .chunks(width)
            .enumerate()
            .rev()
            .find(|(_, row)| row.iter().all(|key| *key == 0))
            .ok_or_else(|| {
                CuaError::new(
                    ErrorCode::Capacity,
                    "This X11 keyboard map has no free Unicode slots.",
                )
            })?;
        let code = setup.min_keycode + index as u8;
        self.connection
            .change_keyboard_mapping(1, code, 2, &[symbol, symbol])
            .map_err(failure)?
            .check()
            .map_err(failure)?;
        self.temporary
            .insert(code, (symbol, map.keysyms_per_keycode, row.to_vec()));
        Ok((code, false))
    }
}
impl Drop for Keyboard {
    fn drop(&mut self) {
        for (code, (symbol, width, saved)) in &self.temporary {
            // Preserve a deliberate external keyboard-layout change.
            let current = self
                .connection
                .get_keyboard_mapping(*code, 1)
                .ok()
                .and_then(|c| c.reply().ok());
            if current.is_some_and(|m| m.keysyms.iter().filter(|k| **k != 0).all(|k| *k == *symbol))
                && let Ok(cookie) = self
                    .connection
                    .change_keyboard_mapping(1, *code, *width, saved)
            {
                let _ = cookie.check();
            }
        }
    }
}
