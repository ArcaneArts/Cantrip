// Copyright 2011 the V8 project authors. All rights reserved.
// Adapted under the BSD-3-Clause terms in ../../third-party/V8-LICENSE.
//! Node-compatible date parsing for protocol refinements, including malformed
//! ISO input that still reaches a continuable custom check.
//! Reference: nodejs/node v24.14.0, deps/v8/src/date/dateparser{,-inl}.{cc,h}.
use super::JsString;
use jiff::{Timestamp, tz::TimeZone};

#[derive(Clone, Copy, PartialEq)]
enum Keyword {
    Unknown,
    Month,
    Zone,
    Separator,
    AmPm,
}
#[derive(Clone, Copy, PartialEq)]
enum Token {
    Number(i64, usize),
    Symbol(u16),
    Word(Keyword, i64, usize),
    Space,
    Unknown,
    End,
}
impl Token {
    fn fixed(self, length: usize) -> Option<i64> {
        match self {
            Self::Number(value, size) if size == length => Some(value),
            _ => None,
        }
    }
    fn number(self) -> Option<i64> {
        match self {
            Self::Number(value, _) => Some(value),
            _ => None,
        }
    }
    fn sign(self) -> Option<i64> {
        match self {
            Self::Symbol(43) => Some(1),
            Self::Symbol(45) => Some(-1),
            _ => None,
        }
    }
    fn z(self) -> bool {
        matches!(self, Self::Word(Keyword::Zone, 0, 1))
    }
}

struct Scanner<'a> {
    input: &'a [u16],
    position: usize,
    next: Token,
}
impl<'a> Scanner<'a> {
    fn new(input: &'a [u16]) -> Self {
        let mut result = Self {
            input,
            position: 0,
            next: Token::End,
        };
        result.next = result.scan();
        result
    }
    fn current(&self) -> u16 {
        self.input.get(self.position).copied().unwrap_or(0)
    }
    fn space(unit: u16) -> bool {
        char::from_u32(u32::from(unit)).is_some_and(crate::text::whitespace)
    }
    fn word_space(unit: u16) -> bool {
        Self::space(unit) && !matches!(unit, 10 | 13 | 0x2028 | 0x2029)
    }
    fn scan(&mut self) -> Token {
        let first = self.current();
        if first == 0 {
            return Token::End;
        }
        if (48..=57).contains(&first) {
            let start = self.position;
            while self.current() == 48 {
                self.position += 1;
            }
            let mut value = 0;
            let mut digits = 0;
            while (48..=57).contains(&self.current()) {
                if digits < 9 {
                    value = value * 10 + i64::from(self.current() - 48);
                }
                digits += 1;
                self.position += 1;
            }
            return Token::Number(value, self.position - start);
        }
        if matches!(first, 58 | 45 | 43 | 46 | 41) {
            self.position += 1;
            return Token::Symbol(first);
        }
        if first >= 65 && !Self::word_space(first) {
            let mut prefix = [0; 3];
            let mut length = 0;
            while self.current() >= 65 && !Self::word_space(self.current()) {
                if length < 3 {
                    let unit = self.current();
                    prefix[length] = if (65..=90).contains(&unit) {
                        unit + 32
                    } else {
                        unit
                    };
                }
                length += 1;
                self.position += 1;
            }
            let months = [
                "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
            ];
            for (index, month) in months.iter().enumerate() {
                if month.encode_utf16().eq(prefix) {
                    return Token::Word(Keyword::Month, index as i64 + 1, length);
                }
            }
            if length <= 3 {
                for (word, kind, value) in [
                    ("am", Keyword::AmPm, 0),
                    ("pm", Keyword::AmPm, 12),
                    ("ut", Keyword::Zone, 0),
                    ("utc", Keyword::Zone, 0),
                    ("z", Keyword::Zone, 0),
                    ("gmt", Keyword::Zone, 0),
                    ("cdt", Keyword::Zone, -5),
                    ("cst", Keyword::Zone, -6),
                    ("edt", Keyword::Zone, -4),
                    ("est", Keyword::Zone, -5),
                    ("mdt", Keyword::Zone, -6),
                    ("mst", Keyword::Zone, -7),
                    ("pdt", Keyword::Zone, -7),
                    ("pst", Keyword::Zone, -8),
                    ("t", Keyword::Separator, 0),
                ] {
                    let mut key = [0; 3];
                    for (index, unit) in word.encode_utf16().enumerate() {
                        key[index] = unit;
                    }
                    if prefix == key {
                        return Token::Word(kind, value, length);
                    }
                }
            }
            return Token::Word(Keyword::Unknown, 0, length);
        }
        if Self::space(first) {
            self.position += 1;
            return Token::Space;
        }
        if first == 40 {
            let mut balance = 0_i64;
            loop {
                match self.current() {
                    40 => balance += 1,
                    41 => balance -= 1,
                    _ => {}
                }
                self.position += 1;
                if balance == 0 || self.current() == 0 {
                    break;
                }
            }
            return Token::Unknown;
        }
        self.position += 1;
        Token::Unknown
    }
    fn take(&mut self) -> Token {
        let result = self.next;
        self.next = self.scan();
        result
    }
    fn skip(&mut self, symbol: u16) -> bool {
        if self.next == Token::Symbol(symbol) {
            self.take();
            true
        } else {
            false
        }
    }
}

#[derive(Default)]
struct Day {
    parts: Vec<i64>,
    month: Option<i64>,
    iso: bool,
}
impl Day {
    fn add(&mut self, value: i64) -> bool {
        if self.parts.len() == 3 {
            false
        } else {
            self.parts.push(value);
            true
        }
    }
    fn fields(&self) -> Option<(i64, i64, i64)> {
        if self.parts.is_empty() {
            return None;
        }
        let mut fields = [1; 3];
        fields[..self.parts.len()].copy_from_slice(&self.parts);
        let (mut year, month, day) = if let Some(month) = self.month {
            if !(1..=31).contains(&fields[0]) {
                (fields[0], month, fields[1])
            } else {
                (fields[1], month, fields[0])
            }
        } else if self.iso || !(1..=31).contains(&fields[0]) {
            (fields[0], fields[1], fields[2])
        } else {
            (fields[2], fields[0], fields[1])
        };
        if !self.iso {
            if (0..=49).contains(&year) {
                year += 2000;
            } else if (50..=99).contains(&year) {
                year += 1900;
            }
        }
        ((1..=12).contains(&month) && (1..=31).contains(&day)).then_some((year, month, day))
    }
}
#[derive(Default)]
struct Time {
    parts: Vec<i64>,
    offset: Option<i64>,
}
impl Time {
    fn add(&mut self, value: i64) -> bool {
        if self.parts.len() == 4 {
            false
        } else {
            self.parts.push(value);
            true
        }
    }
    fn expecting(&self, value: i64) -> bool {
        match self.parts.len() {
            1 | 2 => (0..=59).contains(&value),
            3 => (0..=999).contains(&value),
            _ => false,
        }
    }
    fn finish(&mut self, value: i64) {
        if self.add(value) {
            self.parts.resize(4, 0);
        }
    }
    fn fields(&self) -> Option<[i64; 4]> {
        let mut fields = [0; 4];
        fields[..self.parts.len()].copy_from_slice(&self.parts);
        if let Some(offset) = self.offset {
            if !(0..=12).contains(&fields[0]) {
                return None;
            }
            fields[0] = fields[0] % 12 + offset;
        }
        let [hour, minute, second, millis] = fields;
        if (0..=23).contains(&hour)
            && (0..=59).contains(&minute)
            && (0..=59).contains(&second)
            && (0..=999).contains(&millis)
            || fields == [24, 0, 0, 0]
        {
            Some(fields)
        } else {
            None
        }
    }
}
#[derive(Default)]
struct Zone {
    sign: Option<i64>,
    hour: Option<i64>,
    minute: Option<i64>,
}
impl Zone {
    fn set(&mut self, offset: i64) {
        self.sign = Some(if offset < 0 { -1 } else { 1 });
        self.hour = Some(offset.abs());
        self.minute = Some(0);
    }
    fn utc(&self) -> bool {
        self.hour == Some(0) && self.minute == Some(0)
    }
    fn expecting(&self, value: i64) -> bool {
        self.hour.is_some() && self.minute.is_none() && (0..=59).contains(&value)
    }
    fn seconds(&self) -> Option<Option<i64>> {
        let Some(sign) = self.sign else {
            return Some(None);
        };
        let total = (self.hour.unwrap_or(0) as u32)
            .wrapping_mul(3600)
            .wrapping_add((self.minute.unwrap_or(0) as u32).wrapping_mul(60));
        (total <= i32::MAX as u32).then_some(Some(i64::from(total) * sign))
    }
}
fn milliseconds(token: Token) -> i64 {
    let Token::Number(value, length) = token else {
        unreachable!()
    };
    match length {
        1 => value * 100,
        2 => value * 10,
        3 => value,
        _ => value / 10_i64.pow(length.min(9) as u32 - 3),
    }
}

fn iso(
    scanner: &mut Scanner<'_>,
    day: &mut Day,
    time: &mut Time,
    zone: &mut Zone,
) -> Result<Token, ()> {
    if let Some(sign) = scanner.next.sign() {
        let sign_token = scanner.take();
        let Some(year) = scanner.next.fixed(6) else {
            return Ok(sign_token);
        };
        scanner.take();
        if sign < 0 && year == 0 {
            return Ok(sign_token);
        }
        day.add(sign * year);
    } else if let Some(year) = scanner.next.fixed(4) {
        day.add(year);
        scanner.take();
    } else {
        return Ok(scanner.take());
    }
    if scanner.skip(45) {
        let Some(month) = scanner.next.fixed(2).filter(|n| (1..=12).contains(n)) else {
            return Ok(scanner.take());
        };
        day.add(month);
        scanner.take();
        if scanner.skip(45) {
            let Some(date) = scanner.next.fixed(2).filter(|n| (1..=31).contains(n)) else {
                return Ok(scanner.take());
            };
            day.add(date);
            scanner.take();
        }
    }
    if !matches!(scanner.next, Token::Word(Keyword::Separator, _, _)) {
        if scanner.next != Token::End {
            return Ok(scanner.take());
        }
    } else {
        scanner.take();
        let hour = scanner
            .next
            .fixed(2)
            .filter(|n| (0..=24).contains(n))
            .ok_or(())?;
        time.add(hour);
        scanner.take();
        if !scanner.skip(58) {
            return Err(());
        }
        let minute = scanner
            .next
            .fixed(2)
            .filter(|n| (0..=59).contains(n) && (hour != 24 || *n == 0))
            .ok_or(())?;
        time.add(minute);
        scanner.take();
        if scanner.skip(58) {
            let second = scanner
                .next
                .fixed(2)
                .filter(|n| (0..=59).contains(n) && (hour != 24 || *n == 0))
                .ok_or(())?;
            time.add(second);
            scanner.take();
            if scanner.skip(46) {
                let value = scanner
                    .next
                    .number()
                    .filter(|n| hour != 24 || *n == 0)
                    .ok_or(())?;
                let _ = value;
                time.add(milliseconds(scanner.take()));
            }
        }
        if scanner.next.z() {
            scanner.take();
            zone.set(0);
        } else if let Some(sign) = scanner.next.sign() {
            scanner.take();
            zone.sign = Some(sign);
            if let Some(value) = scanner.next.fixed(4) {
                let (hour, minute) = (value / 100, value % 100);
                if hour > 23 || minute > 59 {
                    return Err(());
                }
                scanner.take();
                zone.hour = Some(hour);
                zone.minute = Some(minute);
            } else {
                let hour = scanner.next.fixed(2).filter(|n| *n <= 23).ok_or(())?;
                scanner.take();
                if !scanner.skip(58) {
                    return Err(());
                }
                let minute = scanner.next.fixed(2).filter(|n| *n <= 59).ok_or(())?;
                scanner.take();
                zone.hour = Some(hour);
                zone.minute = Some(minute);
            }
        }
        if scanner.next != Token::End {
            return Err(());
        }
    }
    if zone.hour.is_none() && time.parts.is_empty() {
        zone.set(0);
    }
    day.iso = true;
    Ok(Token::End)
}

fn days(year: i64, month: i64, day: i64) -> i128 {
    let year = i128::from(year - i64::from(month <= 2));
    let era = year.div_euclid(400);
    let part = year - era * 400;
    let month = i128::from(month + if month > 2 { -3 } else { 9 });
    era * 146097 + part * 365 + part / 4 - part / 100 + (153 * month + 2) / 5 + i128::from(day)
        - 1
        - 719468
}

pub(super) fn utc_fields(value: i64) -> Option<(i64, i64, i64)> {
    if value.unsigned_abs() > 8_640_000_000_000_000 {
        return None;
    }
    // Invert `days` over the complete ECMAScript TimeClip range. Chrono and
    // Jiff have narrower civil-year ranges than Date.prototype.toISOString.
    let shifted = value.div_euclid(86_400_000) + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let march_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * march_month + 2) / 5 + 1;
    let month = march_month + if march_month < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    Some((year, month, day))
}

pub(super) fn utc_milliseconds(year: i64, month: i64, day: i64) -> Option<i64> {
    // Date.UTC uses a zero-based month and maps years 0..99 into 1900..1999
    // before normalizing the month and day.
    let year = if (0..=99).contains(&year) {
        year + 1900
    } else {
        year
    };
    let year = year + month.div_euclid(12);
    let value = days(year, month.rem_euclid(12) + 1, day) * 86_400_000;
    (value.abs() <= 8_640_000_000_000_000).then_some(value as i64)
}

pub(super) fn iso_milliseconds(value: i64) -> Option<String> {
    let (year, month, day) = utc_fields(value)?;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    let clock = value.rem_euclid(86_400_000);
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        clock / 3_600_000,
        clock / 60_000 % 60,
        clock / 1000 % 60,
        clock % 1000
    ))
}
fn local(value: i128, year: i64, month: i64, day: i64, clock: [i64; 4]) -> Option<i64> {
    let zone = crate::environment::timezone();
    // Jiff's civil range is smaller than ECMAScript TimeClip. Outside it,
    // retain the Gregorian 400-year calendar: future years use the continuing
    // TZif rules, ancient years use the zone's pre-transition offset.
    let lookup_year = if year > 9998 {
        year.rem_euclid(400) + 2400
    } else if year < -9998 {
        year.rem_euclid(400) - 9600
    } else {
        year
    };
    let lookup_millis: i64 = (days(lookup_year, month, day) * 86400000
        + i128::from(clock[0] * 3600000 + clock[1] * 60000 + clock[2] * 1000 + clock[3]))
    .try_into()
    .ok()?;
    let wall = TimeZone::UTC.to_datetime(Timestamp::from_millisecond(lookup_millis).ok()?);
    // Compatible disambiguation chooses the earlier fold and shifts a gap
    // forward, including non-hour transitions and skipped calendar days.
    let utc = zone.to_ambiguous_timestamp(wall).compatible().ok()?;
    let offset = lookup_millis - utc.as_millisecond();
    i64::try_from(value).ok()?.checked_sub(offset)
}

pub(super) fn parse(input: &JsString) -> Option<i64> {
    let mut scanner = Scanner::new(input.units());
    let (mut day, mut time, mut zone) = (Day::default(), Time::default(), Zone::default());
    let mut token = iso(&mut scanner, &mut day, &mut time, &mut zone).ok()?;
    let mut has_number = !day.parts.is_empty();
    while token != Token::End {
        match token {
            Token::Number(value, _) => {
                has_number = true;
                if scanner.skip(58) {
                    if scanner.skip(58) {
                        if !time.parts.is_empty() {
                            return None;
                        }
                        time.add(value);
                        time.add(0);
                    } else {
                        if !time.add(value) {
                            return None;
                        }
                        scanner.skip(46);
                    }
                } else if scanner.skip(46) && time.expecting(value) {
                    time.add(value);
                    scanner.next.number()?;
                    let millis = milliseconds(scanner.take());
                    time.finish(millis);
                } else if zone.expecting(value) {
                    zone.minute = Some(value);
                } else if time.expecting(value) {
                    time.finish(value);
                    if !matches!(scanner.next, Token::End | Token::Space)
                        && !scanner.next.z()
                        && scanner.next.sign().is_none()
                    {
                        return None;
                    }
                } else {
                    if !day.add(value) {
                        return None;
                    }
                    scanner.skip(45);
                }
            }
            Token::Word(kind, value, _) => {
                if kind == Keyword::AmPm && !time.parts.is_empty() {
                    time.offset = Some(value);
                } else if kind == Keyword::Month {
                    day.month = Some(value);
                    scanner.skip(45);
                } else if kind == Keyword::Zone && has_number {
                    zone.set(value);
                } else if has_number || scanner.next.number().is_some() {
                    return None;
                }
            }
            value if value.sign().is_some() && (zone.utc() || !time.parts.is_empty()) => {
                zone.sign = value.sign();
                let (number, length) = if let Token::Number(number, length) = scanner.next {
                    scanner.take();
                    (number, length)
                } else {
                    (0, 0)
                };
                has_number = true;
                if scanner.next == Token::Symbol(58) {
                    zone.hour = Some(number);
                    zone.minute = None;
                } else if length == 1 || length == 2 {
                    zone.hour = Some(number);
                    zone.minute = Some(0);
                } else if length == 3 || length == 4 {
                    zone.hour = Some(number / 100);
                    zone.minute = Some(number % 100);
                } else {
                    return None;
                }
            }
            value if has_number && (value.sign().is_some() || value == Token::Symbol(41)) => {
                return None;
            }
            _ => {}
        }
        token = scanner.take();
    }
    let (year, month, date) = day.fields()?;
    let clock = time.fields()?;
    let value = days(year, month, date) * 86400000
        + i128::from(clock[0] * 3600000 + clock[1] * 60000 + clock[2] * 1000 + clock[3]);
    let value = match zone.seconds()? {
        Some(offset) => (value - i128::from(offset) * 1000).try_into().ok()?,
        None => local(value, year, month, date, clock)?,
    };
    (-8_640_000_000_000_000..=8_640_000_000_000_000)
        .contains(&value)
        .then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::Value;
    use anyhow::{Context, Result};
    use std::{path::PathBuf, process::Command};

    #[test]
    fn iso_format_matches_actual_node_over_full_time_clip() -> Result<()> {
        let output = Command::new("node").args(["-e", r#"
let seed=36142;
const random=()=>seed=(Math.imul(seed,1664525)+1013904223)>>>0;
const values=[-8640000000000001,-8640000000000000,-1,0,1,8640000000000000,8640000000000001,253402300800000,-62167219200000];
for(let i=0;i<10000;i++)values.push((random()*2097152+(random()%2097152))*(random()%2?1:-1));
console.log(JSON.stringify(values.map(value=>{let iso=null;try{iso=new Date(value).toISOString()}catch{}return[value,iso]})));
"#]).output()?;
        anyhow::ensure!(
            output.status.success(),
            "Node ISO oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let cases: Vec<(i64, Option<String>)> = serde_json::from_slice(&output.stdout)?;
        for (value, expected) in &cases {
            assert_eq!(
                &iso_milliseconds(*value),
                expected,
                "Date.toISOString({value})"
            );
        }
        println!(
            "{} actual Node ISO timestamps matched across TimeClip",
            cases.len()
        );
        Ok(())
    }

    #[test]
    fn date_parse_matches_the_actual_node_runtime() -> Result<()> {
        if std::env::var_os("CANTRIP_DATE_ORACLE_CHILD").is_none() {
            for timezone in [
                "UTC",
                "America/Chicago",
                "Europe/Berlin",
                "Asia/Kathmandu",
                "Pacific/Apia",
                "Australia/Lord_Howe",
                "Etc/GMT+5",
                "america/chicago",
                "europe/dublin",
                "US/Central",
                "Eire",
                "Invalid/Timezone",
                "UTC0",
                "",
            ]
            .into_iter()
            .map(Some)
            .chain([None])
            {
                let mut child = Command::new(std::env::current_exe()?);
                child
                    .args([
                        "--exact",
                        "wire::js_date::tests::date_parse_matches_the_actual_node_runtime",
                        "--nocapture",
                    ])
                    .env("CANTRIP_DATE_ORACLE_CHILD", "1");
                if let Some(timezone) = timezone {
                    child.env("TZ", timezone);
                } else {
                    child.env_remove("TZ");
                }
                let output = child.output()?;
                let timezone = timezone.unwrap_or("<system>");
                anyhow::ensure!(
                    output.status.success(),
                    "Date parser {timezone} failed:\n{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                let stdout = String::from_utf8_lossy(&output.stdout);
                let comparisons = stdout
                    .lines()
                    .find_map(|line| line.strip_prefix("DATE_ORACLE_DONE "))
                    .and_then(|count| count.parse::<usize>().ok())
                    .context("date child did not report completed comparisons")?;
                anyhow::ensure!(comparisons > 0, "date child compared no cases");
                println!("Date.parse matched {comparisons} actual values in {timezone}");
            }
            return Ok(());
        }
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_owned();
        let output = Command::new("node")
            .args([
                "scripts/server-rust/worker-wire-oracle.mjs",
                "--date-vectors",
            ])
            .current_dir(root)
            .output()?;
        anyhow::ensure!(
            output.status.success(),
            "Date oracle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let cases: Value = serde_json::from_slice(&output.stdout)?;
        let cases = cases.as_array().context("date vectors")?;
        for (index, case) in cases.iter().enumerate() {
            let input = case["input"].as_js_string().context("date input")?;
            let actual = parse(input).map_or(Value::Null, |value| Value::Number(value as f64));
            assert_eq!(
                actual, case["millis"],
                "Date.parse case {index}: {}",
                case["input"]
            );
        }
        println!("DATE_ORACLE_DONE {}", cases.len());
        Ok(())
    }
}
