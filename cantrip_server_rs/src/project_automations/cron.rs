//! Croner 10.0.1's five-part grammar and diagnostic ordering. Native masks also
//! retain its DOM/DOW wildcard distinction before question-mark substitution.
//! Behavior adapted from Croner (MIT); see third-party/croner-compat/LICENSE.
use crate::wire::{JsString, Value, coercion};

pub(super) struct Pattern {
    pub fields: [Vec<u8>; 7],
    pub nearest: Vec<u8>,
    pub last: bool,
    pub last_weekday: bool,
    pub star_dom: bool,
    pub star_dow: bool,
    pub and: bool,
}
const NAMES: [&str; 8] = [
    "second",
    "minute",
    "hour",
    "day",
    "month",
    "dayOfWeek",
    "year",
    "nearestWeekdays",
];
const LENGTHS: [usize; 8] = [60, 60, 24, 31, 12, 7, 10000, 31];

// Encode each UTF-16 unit independently so even unpaired surrogates survive
// diagnostic interpolation. Supplementary private scalars cannot collide with
// input scalars because input is first split into its original UTF-16 units.
fn encoded(value: &JsString) -> String {
    value
        .units()
        .iter()
        .map(|u| {
            char::from_u32(if (0xd800..=0xdfff).contains(u) {
                0xf0000 + u32::from(*u - 0xd800)
            } else {
                u32::from(*u)
            })
            .unwrap()
        })
        .collect()
}
fn decoded(value: &str) -> JsString {
    let mut units = Vec::new();
    for ch in value.chars() {
        if (0xf0000..=0xf07ff).contains(&(ch as u32)) {
            units.push((ch as u32 - 0xf0000) as u16 + 0xd800);
        } else {
            units.extend(ch.encode_utf16(&mut [0; 2]).iter().copied());
        }
    }
    JsString::new(units)
}
fn replace_ci(value: &str, from: &str, to: &str) -> String {
    let lower = value.to_ascii_lowercase();
    let mut out = String::new();
    let mut at = 0;
    while let Some(index) = lower[at..].find(from) {
        let index = at + index;
        out.push_str(&value[at..index]);
        out.push_str(to);
        at = index + from.len();
    }
    out.push_str(&value[at..]);
    out
}
fn integer(value: &str) -> f64 {
    let end = value.bytes().take_while(u8::is_ascii_digit).count();
    if end == 0 {
        f64::NAN
    } else {
        value[..end].parse().unwrap_or(f64::INFINITY)
    }
}
fn numeric(value: f64) -> String {
    coercion::string(&Value::Number(value))
        .unwrap()
        .lossy()
        .into_owned()
}
fn nickname(value: &str) -> Result<&str, String> {
    Ok(match crate::text::trim(value).to_ascii_lowercase().as_str() {
        "@yearly" | "@annually" => "0 0 1 1 *", "@monthly" => "0 0 1 * *", "@weekly" => "0 0 * * 0",
        "@daily" | "@midnight" => "0 0 * * *", "@hourly" => "0 * * * *",
        "@reboot" => return Err("CronPattern: @reboot is not supported in this environment. This is an event-based trigger that requires system startup detection.".into()), _ => value,
    })
}
impl Pattern {
    fn mask(&mut self, field: usize) -> &mut Vec<u8> {
        if field == 7 {
            &mut self.nearest
        } else {
            &mut self.fields[field]
        }
    }
    fn set(&mut self, field: usize, mut value: f64, nth: Option<&str>) -> Result<(), String> {
        if field == 5 && value == 7.0 {
            value = 0.0;
        }
        if value < if field == 6 { 1.0 } else { 0.0 } || value >= LENGTHS[field] as f64 {
            return Err(format!(
                "CronPattern: Invalid value for {}: {}{}",
                NAMES[field],
                numeric(value),
                if field == 6 {
                    " (supported range: 1-9999)"
                } else {
                    ""
                }
            ));
        }
        if field == 5 {
            let mask = &mut self.fields[5][value as usize];
            match nth.filter(|s| !s.is_empty()) {
                None => *mask = 63,
                Some(nth) if nth.eq_ignore_ascii_case("L") => *mask |= 32,
                Some(nth) => {
                    let number =
                        coercion::number(Some(&Value::String(JsString::from(nth)))).unwrap();
                    if number > 0.0 && number < 6.0 {
                        *mask |= 1 << (number as u8 - 1);
                    } else {
                        return Err(format!(
                            "CronPattern: nth weekday out of range, should be 1-5 or L. Value: {nth}, Type: string"
                        ));
                    }
                }
            }
        } else {
            self.mask(field)[value as usize] = 1;
        }
        Ok(())
    }
    fn nth<'a>(&self, value: &'a str, field: usize) -> Result<(&'a str, Option<&'a str>), String> {
        if value.contains('#') {
            if field != 5 {
                return Err("CronPattern: nth (#) only allowed in day-of-week field".into());
            }
            let mut parts = value.split('#');
            return Ok((parts.next().unwrap(), parts.next()));
        }
        if value.ends_with(['L', 'l']) {
            if field != 5 {
                return Err("CronPattern: L modifier only allowed in day-of-week field (use L alone for day-of-month)".into());
            }
            return Ok((&value[..value.len() - 1], Some("L")));
        }
        Ok((value, None))
    }
    fn range(
        &self,
        from: f64,
        to: f64,
        step: Option<f64>,
        field: usize,
        input: &str,
    ) -> Result<(), String> {
        if from > to {
            return Err(format!(
                "CronPattern: From value is larger than to value: '{input}'"
            ));
        }
        if let Some(step) = step {
            if step == 0.0 {
                return Err("CronPattern: Syntax error, illegal stepping: 0".into());
            }
            if step > LENGTHS[field] as f64 {
                return Err(format!(
                    "CronPattern: Syntax error, steps cannot be greater than maximum value of part ({})",
                    LENGTHS[field]
                ));
            }
        }
        Ok(())
    }
    fn part(&mut self, field: usize, input: &str) -> Result<(), String> {
        if input.is_empty() && !(field == 3 && (self.last || self.last_weekday)) {
            return Err(format!(
                "CronPattern: configuration entry {} ({input}) is empty, check for trailing spaces.",
                NAMES[field]
            ));
        }
        if input == "*" {
            self.mask(field).fill(if field == 5 { 63 } else { 1 });
            return Ok(());
        }
        if input.contains(',') {
            for part in input.split(',') {
                self.part(field, part)?;
            }
            return Ok(());
        }
        let offset = if matches!(field, 3 | 4) { -1.0 } else { 0.0 };
        if input.contains('-') || input.contains('/') {
            let range = input.contains('-');
            let stepping = input.contains('/');
            if input.to_ascii_uppercase().contains('W') {
                return Err(format!(
                    "CronPattern: Syntax error, W is not allowed in {}.",
                    if range && stepping {
                        "ranges with stepping"
                    } else if range {
                        "a range"
                    } else {
                        "parts with stepping"
                    }
                ));
            }
            let (value, nth) = self.nth(input, field)?;
            let (from, to, step) = if range && stepping {
                let pieces: Vec<_> = value.split(['-', '/']).collect();
                if pieces.len() != 3
                    || pieces
                        .iter()
                        .any(|s| s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()))
                {
                    return Err(format!(
                        "CronPattern: Syntax error, illegal range with stepping: '{input}'"
                    ));
                }
                (
                    integer(pieces[0]) + offset,
                    integer(pieces[1]) + offset,
                    Some(integer(pieces[2])),
                )
            } else if range {
                let pieces: Vec<_> = value.split('-').collect();
                if pieces.len() != 2 {
                    return Err(format!(
                        "CronPattern: Syntax error, illegal range: '{input}'"
                    ));
                }
                let from = integer(pieces[0]) + offset;
                let to = integer(pieces[1]) + offset;
                if from.is_nan() {
                    return Err("CronPattern: Syntax error, illegal lower range (NaN)".into());
                }
                if to.is_nan() {
                    return Err("CronPattern: Syntax error, illegal upper range (NaN)".into());
                }
                (from, to, None)
            } else {
                let pieces: Vec<_> = value.split('/').collect();
                if pieces.len() != 2 {
                    return Err(format!(
                        "CronPattern: Syntax error, illegal stepping: '{input}'"
                    ));
                }
                if pieces[0] != "*" {
                    return Err(format!(
                        "CronPattern: Syntax error, stepping with {} prefix ('{input}') is not allowed. Use wildcard (*/step) or range (min-max/step) instead.",
                        if pieces[0].is_empty() {
                            "missing"
                        } else {
                            "numeric"
                        }
                    ));
                }
                let step = integer(pieces[1]);
                if step.is_nan() {
                    return Err("CronPattern: Syntax error, illegal stepping: (NaN)".into());
                }
                (0.0, (LENGTHS[field] - 1) as f64, Some(step))
            };
            self.range(from, to, step, field, input)?;
            let mut at = from;
            while at <= to {
                self.set(field, at, nth)?;
                at += step.unwrap_or(1.0);
            }
        } else if !input.is_empty() {
            let (value, nth) = self.nth(input, field)?;
            let nearest = input.to_ascii_uppercase().contains('W');
            if nearest && field != 3 {
                return Err(
                    "CronPattern: Nearest weekday modifier (W) only allowed in day-of-month."
                        .into(),
                );
            }
            let field = if nearest { 7 } else { field };
            let value = integer(value) + offset;
            if value.is_nan() {
                return Err(format!(
                    "CronPattern: {} is not a number: '{input}'",
                    NAMES[field]
                ));
            }
            self.set(field, value, nth)?;
        }
        Ok(())
    }
}
pub(super) fn parse(input: &JsString) -> Result<Pattern, JsString> {
    parse_inner(input).map_err(|e| decoded(&e))
}
fn parse_inner(input: &JsString) -> Result<Pattern, String> {
    let encoded = encoded(input);
    let value = nickname(&encoded)?;
    let mut parts: Vec<String> = value
        .split(crate::text::whitespace)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if !(5..=7).contains(&parts.len()) {
        return Err(format!(
            "CronPattern: invalid configuration format ('{value}'), exactly five, six, or seven space separated parts are required."
        ));
    }
    if parts.len() != 5 {
        return Err(format!(
            "CronPattern: mode '5-part' requires exactly 5 parts, but pattern '{value}' has {} parts.",
            parts.len()
        ));
    }
    parts.insert(0, "0".into());
    parts.push("*".into());
    let mut out = Pattern {
        fields: std::array::from_fn(|i| vec![0; LENGTHS[i]]),
        nearest: vec![0; 31],
        last: false,
        last_weekday: false,
        star_dom: false,
        star_dow: false,
        and: false,
    };
    if parts[3].eq_ignore_ascii_case("LW") {
        out.last_weekday = true;
        parts[3].clear();
    } else if parts[3].to_ascii_uppercase().contains('L') {
        out.last = true;
        parts[3] = parts[3].replace(['L', 'l'], "");
    }
    out.star_dom = parts[3] == "*";
    for (from, to) in [
        "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
    ]
    .iter()
    .zip(1..=12)
    {
        parts[4] = replace_ci(&parts[4], from, &to.to_string());
    }
    parts[5] = replace_ci(&parts[5], "-sun", "-7");
    for (from, to) in ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
        .iter()
        .zip(0..=6)
    {
        parts[5] = replace_ci(&parts[5], from, &to.to_string());
    }
    if parts[5].starts_with('+') {
        out.and = true;
        parts[5].remove(0);
        if parts[5].is_empty() {
            return Err(
                "CronPattern: Day-of-week field cannot be empty after '+' modifier.".into(),
            );
        }
    }
    out.star_dow = parts[5] == "*";
    for part in &mut parts {
        *part = part.replace('?', "*");
    }
    for (i, part) in parts.iter().enumerate() {
        if part.chars().any(|c| {
            !(c.is_ascii_digit()
                || "/*,-".contains(c)
                || i == 3 && "WwLl".contains(c)
                || i == 5 && "#Ll".contains(c))
        }) {
            return Err(format!(
                "CronPattern: configuration entry {i} ({part}) contains illegal characters."
            ));
        }
    }
    for (i, part) in parts.iter().enumerate() {
        out.part(i, part)?;
    }
    Ok(out)
}
