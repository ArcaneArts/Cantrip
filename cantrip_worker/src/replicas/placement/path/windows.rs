//! Node win32.normalize lexical semantics, independent of the host filesystem.
use cantrip_wire::JsString;
fn separator(unit: u16) -> bool {
    unit == 47 || unit == 92
}
fn drive(unit: u16) -> bool {
    unit < 128 && (unit as u8).is_ascii_alphabetic()
}
fn reserved(units: &[u16]) -> bool {
    let uppercase: Vec<u16> = units
        .iter()
        .map(|u| {
            if *u < 128 {
                (*u as u8).to_ascii_uppercase() as u16
            } else {
                *u
            }
        })
        .collect();
    let units = uppercase.as_slice();
    ["CON", "PRN", "AUX", "NUL"]
        .iter()
        .any(|name| units.iter().copied().eq(name.encode_utf16()))
        || (units.len() == 4
            && (units.starts_with(&[67, 79, 77]) || units.starts_with(&[76, 80, 84]))
            && ((49..=57).contains(&units[3]) || [0xb9, 0xb2, 0xb3].contains(&units[3])))
}
pub(super) fn normalize(value: &JsString) -> JsString {
    let units = value.units();
    if units.is_empty() {
        return ".".into();
    }
    if units.len() == 1 {
        return if units[0] == 47 {
            "\\".into()
        } else {
            value.clone()
        };
    }
    let mut absolute = separator(units[0]);
    let mut start = usize::from(absolute && !separator(units[1]));
    let mut device: Option<Vec<u16>> = None;
    let colon = units.iter().position(|u| *u == 58);
    if absolute && separator(units[1]) {
        let first_end = units[2..].iter().position(|u| separator(*u)).map(|i| i + 2);
        if let Some(first_end) = first_end.filter(|i| *i > 2) {
            let share_start = (first_end..units.len()).find(|i| !separator(units[*i]));
            if let Some(share_start) = share_start {
                let share_end = (share_start..units.len())
                    .find(|i| separator(units[*i]))
                    .unwrap_or(units.len());
                let first = &units[2..first_end];
                if first == [46] || first == [63] {
                    device = Some([&[92, 92][..], first].concat());
                    start = 4;
                    if let Some(colon) = colon.filter(|i| *i >= 4 && reserved(&units[4..*i])) {
                        device = Some([&[92, 92, 63, 92][..], &units[4..=colon]].concat());
                        start = colon + 1;
                    }
                } else {
                    device = Some(
                        [&[92, 92][..], first, &[92], &units[share_start..share_end]].concat(),
                    );
                    start = share_end;
                    if share_end == units.len() {
                        let mut result = device.unwrap();
                        result.push(92);
                        return JsString::new(result);
                    }
                }
            }
        }
    } else if !absolute {
        if colon == Some(1) && drive(units[0]) {
            device = Some(units[..2].to_vec());
            start = 2;
            absolute = units.get(2).is_some_and(|u| separator(*u));
            if absolute {
                start = 3;
            }
        } else if let Some(colon) = colon.filter(|i| *i > 0 && reserved(&units[..*i])) {
            device = Some(units[..=colon].to_vec());
            start = colon + 1;
        }
    }
    let mut parts: Vec<&[u16]> = Vec::new();
    for part in units[start..].split(|unit| separator(*unit)) {
        if part.is_empty() || part == [46] {
            continue;
        }
        if part == [46, 46] {
            if parts.last().is_some_and(|last| *last != [46, 46]) {
                parts.pop();
            } else if !absolute {
                parts.push(part);
            }
        } else {
            parts.push(part);
        }
    }
    let mut tail = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        if i != 0 {
            tail.push(92);
        }
        tail.extend_from_slice(part);
    }
    if tail.is_empty() && !absolute {
        tail.push(46);
    }
    if !tail.is_empty() && separator(*units.last().unwrap()) {
        tail.push(92);
    }
    if !absolute
        && device.is_none()
        && colon.is_some()
        && (tail.len() >= 2 && drive(tail[0]) && tail[1] == 58
            || units
                .iter()
                .enumerate()
                .any(|(i, u)| *u == 58 && units.get(i + 1).is_none_or(|u| separator(*u))))
    {
        return JsString::new([&[46, 92][..], &tail].concat());
    }
    let reserved = colon.is_some_and(|i| reserved(&units[..i]));
    let mut result = if reserved { vec![46, 92] } else { Vec::new() };
    result.extend(device.unwrap_or_default());
    if absolute && !reserved {
        result.push(92);
    }
    result.extend(tail);
    JsString::new(result)
}

#[test]
fn normalizes_windows_paths_against_node24_vectors() {
    let vectors = cantrip_wire::parse_json_text(include_str!(
        "../../../../tests/fixtures/replica-placement-windows-paths.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        let vector = vector.as_array().unwrap();
        let input = vector[0].as_js_string().unwrap();
        assert_eq!(
            normalize(input),
            *vector[1].as_js_string().unwrap(),
            "{input:?}"
        );
    }
}
