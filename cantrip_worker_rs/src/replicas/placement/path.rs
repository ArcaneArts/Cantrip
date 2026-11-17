use crate::filesystem::paths;
use cantrip_wire::{JsString, Value};
use std::path::{Path, PathBuf};
#[cfg(any(windows, test))]
mod windows;
pub(super) fn value(value: &Value) -> &JsString {
    value.as_js_string().expect("typed placement path")
}
pub(super) fn native(value: &Value) -> PathBuf {
    paths::native(self::value(value))
}
pub(super) fn normalized(value: &JsString) -> JsString {
    #[cfg(windows)]
    {
        windows::normalize(value)
    }
    #[cfg(not(windows))]
    {
        let units = value.units();
        let absolute = units.first() == Some(&47);
        let trailing = units.last() == Some(&47);
        let mut parts: Vec<&[u16]> = Vec::new();
        for part in units.split(|unit| *unit == 47) {
            if part.is_empty() || part == [46] {
                continue;
            }
            if part == [46, 46] {
                if parts.last().is_some_and(|part| *part != [46, 46]) {
                    parts.pop();
                } else if !absolute {
                    parts.push(part);
                }
            } else {
                parts.push(part);
            }
        }
        let mut output = if absolute { vec![47] } else { Vec::new() };
        for (index, part) in parts.iter().enumerate() {
            if index > 0 {
                output.push(47);
            }
            output.extend_from_slice(part);
        }
        if output.is_empty() {
            output.push(46);
        }
        if trailing && output.last() != Some(&47) {
            output.push(47);
        }
        JsString::new(output)
    }
}
pub(super) fn equal(left: &Value, right: &Value) -> bool {
    #[cfg(not(windows))]
    {
        normalized(value(left)) == normalized(value(right))
    }
    #[cfg(windows)]
    {
        fn comparable(value: &Value) -> JsString {
            let value = normalized(self::value(value));
            let units = value.units();
            let unc = "\\\\?\\UNC\\".encode_utf16().collect::<Vec<_>>();
            let prefix = "\\\\?\\".encode_utf16().collect::<Vec<_>>();
            let units = if let Some(rest) = units.strip_prefix(unc.as_slice()) {
                [&[92, 92][..], rest].concat()
            } else if let Some(rest) = units.strip_prefix(prefix.as_slice()) {
                rest.to_vec()
            } else {
                units.to_vec()
            };
            JsString::new(units).lowercase()
        }
        comparable(left) == comparable(right)
    }
}
pub(super) fn append(value: &Value, suffix: &JsString) -> Value {
    Value::String(JsString::new(
        self::value(value)
            .units()
            .iter()
            .chain(suffix.units())
            .copied()
            .collect(),
    ))
}
pub(super) fn child(parent: &Path, name: &JsString) -> Value {
    let mut units = paths::text(parent).units().to_vec();
    if units
        .last()
        .is_none_or(|u| *u != std::path::MAIN_SEPARATOR as u16)
    {
        units.push(std::path::MAIN_SEPARATOR as u16);
    }
    units.extend(name.units());
    Value::String(JsString::new(units))
}
pub(super) fn basename(value: &JsString) -> JsString {
    #[cfg(windows)]
    {
        paths::text(Path::new(paths::native(value).file_name().unwrap()))
    }
    #[cfg(not(windows))]
    {
        JsString::new(
            value
                .units()
                .rsplit(|u| *u == 47)
                .next()
                .unwrap_or(&[])
                .to_vec(),
        )
    }
}
