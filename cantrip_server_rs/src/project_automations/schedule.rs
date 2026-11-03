//! Source-compatible interval anchors and civil cron evaluation. Inputs have
//! already passed the project automation schedule contract.
use crate::wire::JsString;
use crate::wire::{self, Value};
use anyhow::{Context, Result};

const DAY: i64 = 86_400_000;
const DATE_LIMIT: i128 = 8_640_000_000_000_000;

fn clipped(value: i128) -> Option<i64> {
    (value.abs() <= DATE_LIMIT).then_some(value as i64)
}
fn number(value: &Value) -> Result<i64> {
    Ok(value
        .as_f64()
        .context("Validated automation schedule number")? as i64)
}
fn start(schedule: &Value) -> Option<i64> {
    wire::date_milliseconds(schedule["startsAt"].as_js_string()?)
}

fn add_calendar(start: i64, count: i64, year_unit: bool) -> Option<i64> {
    let (year, month, day) = wire::date_utc_fields(start)?;
    let target_month = month - 1 + count * if year_unit { 12 } else { 1 };
    let target_year = year + target_month.div_euclid(12);
    let normalized_month = target_month.rem_euclid(12);
    if target_year > 275_000 {
        return None;
    }
    // Source uses Date.UTC twice: year 0..99 maps to 1900..1999 even for
    // daysInUtcMonth, and month/day normalization happens after that mapping.
    let last_day = wire::date_utc_milliseconds(target_year, normalized_month + 1, 0)?;
    let (_, _, last_day) = wire::date_utc_fields(last_day)?;
    let midnight = wire::date_utc_milliseconds(target_year, normalized_month, day.min(last_day))?;
    clipped(i128::from(midnight) + i128::from(start.rem_euclid(DAY)))
}

fn interval(schedule: &Value, after: i64) -> Result<Option<i64>> {
    let Some(start) = start(schedule) else {
        return Ok(None);
    };
    if after < start {
        return Ok(Some(start));
    }
    let every = number(&schedule["every"])?;
    let unit = schedule["unit"]
        .as_str()
        .context("Validated automation interval unit")?;
    let fixed = match unit {
        "minute" => Some(60_000),
        "hour" => Some(3_600_000),
        "day" => Some(DAY),
        "week" => Some(7 * DAY),
        _ => None,
    };
    if let Some(fixed) = fixed {
        let interval = i128::from(fixed) * i128::from(every);
        let occurrence = ((i128::from(after) - i128::from(start)) / interval + 1).max(1);
        return Ok(clipped(i128::from(start) + occurrence * interval));
    }
    let year_unit = unit == "year";
    if !year_unit && unit != "month" {
        return Ok(None);
    }
    let Some((start_year, start_month, _)) = wire::date_utc_fields(start) else {
        return Ok(None);
    };
    let Some((after_year, after_month, _)) = wire::date_utc_fields(after) else {
        return Ok(None);
    };
    let rough = if year_unit {
        after_year - start_year
    } else {
        (after_year - start_year) * 12 + after_month - start_month
    };
    let mut occurrence = rough.div_euclid(every).max(1);
    for _ in 0..4 {
        let Some(candidate) = add_calendar(start, occurrence * every, year_unit) else {
            return Ok(None);
        };
        if candidate > after {
            return Ok(Some(candidate));
        }
        occurrence += 1;
    }
    Ok(None)
}

fn named_zone(name: &str) -> Result<jiff::tz::TimeZone, jiff::Error> {
    static DATABASE: std::sync::OnceLock<jiff::tz::TimeZoneDatabase> = std::sync::OnceLock::new();
    DATABASE
        .get_or_init(jiff::tz::TimeZoneDatabase::bundled)
        .get(name)
}
pub(crate) fn timezone(name: &str) -> Result<jiff::tz::TimeZone> {
    let legacy = match name.to_ascii_lowercase().as_str() {
        "etc/unknown" | "factory" | "posixrules" => anyhow::bail!("Invalid automation time zone"),
        "us/pacific-new" => Some(named_zone("America/Los_Angeles")),
        "systemv/ast4" => {
            Some(jiff::tz::Offset::from_seconds(-4 * 3600).map(jiff::tz::TimeZone::fixed))
        }
        "systemv/cst6" => {
            Some(jiff::tz::Offset::from_seconds(-6 * 3600).map(jiff::tz::TimeZone::fixed))
        }
        "systemv/est5" => {
            Some(jiff::tz::Offset::from_seconds(-5 * 3600).map(jiff::tz::TimeZone::fixed))
        }
        "systemv/hst10" => {
            Some(jiff::tz::Offset::from_seconds(-10 * 3600).map(jiff::tz::TimeZone::fixed))
        }
        "systemv/mst7" => {
            Some(jiff::tz::Offset::from_seconds(-7 * 3600).map(jiff::tz::TimeZone::fixed))
        }
        "systemv/pst8" => {
            Some(jiff::tz::Offset::from_seconds(-8 * 3600).map(jiff::tz::TimeZone::fixed))
        }
        "systemv/yst9" => {
            Some(jiff::tz::Offset::from_seconds(-9 * 3600).map(jiff::tz::TimeZone::fixed))
        }
        "systemv/ast4adt" => Some(jiff::tz::TimeZone::tzif(
            name,
            include_bytes!("zones/ast4adt.tzif"),
        )),
        "systemv/cst6cdt" => Some(jiff::tz::TimeZone::tzif(
            name,
            include_bytes!("zones/cst6cdt.tzif"),
        )),
        "systemv/est5edt" => Some(jiff::tz::TimeZone::tzif(
            name,
            include_bytes!("zones/est5edt.tzif"),
        )),
        "systemv/mst7mdt" => Some(jiff::tz::TimeZone::tzif(
            name,
            include_bytes!("zones/mst7mdt.tzif"),
        )),
        "systemv/pst8pdt" => Some(jiff::tz::TimeZone::tzif(
            name,
            include_bytes!("zones/pst8pdt.tzif"),
        )),
        "systemv/yst9ydt" => Some(jiff::tz::TimeZone::tzif(
            name,
            include_bytes!("zones/yst9ydt.tzif"),
        )),
        _ => None,
    };
    if let Some(zone) = legacy {
        return Ok(zone?);
    }
    // Source ICU and the bundled tzdb both use 2026e. Host zoneinfo can lag
    // behind them: actual America/Inuvik fold comparisons exposed that drift.
    if let Ok(zone) = named_zone(name) {
        return Ok(zone);
    }
    // Intl.DateTimeFormat also accepts numeric offset identifiers. Contract
    // validation decides which spellings/ranges Source accepts.
    let bytes = name.as_bytes();
    let sign = match bytes.first() {
        Some(b'+') => 1,
        Some(b'-') => -1,
        _ => anyhow::bail!("Invalid automation time zone"),
    };
    let digits = |value: &[u8]| -> Option<i32> {
        value.iter().try_fold(0, |n, byte| {
            byte.is_ascii_digit()
                .then(|| n * 10 + i32::from(*byte - b'0'))
        })
    };
    let (hour, minute) = match bytes.len() {
        3 => (digits(&bytes[1..3]), Some(0)),
        5 => (digits(&bytes[1..3]), digits(&bytes[3..5])),
        6 if bytes[3] == b':' => (digits(&bytes[1..3]), digits(&bytes[4..6])),
        _ => anyhow::bail!("Invalid automation time zone"),
    };
    let hour = hour
        .filter(|n| *n <= 23)
        .context("Automation offset hour")?;
    let minute = minute
        .filter(|n| *n <= 59)
        .context("Automation offset minute")?;
    Ok(jiff::tz::TimeZone::fixed(jiff::tz::Offset::from_seconds(
        sign * (hour * 3600 + minute * 60),
    )?))
}

pub fn next(schedule: &Value, after: i64) -> Result<Option<i64>> {
    if schedule["kind"] == "interval" {
        return interval(schedule, after);
    }
    let expression = if schedule["kind"] == "weekly" {
        let days = schedule["weekdays"]
            .as_array()
            .context("Validated automation weekdays")?
            .iter()
            .map(Value::stringify)
            .collect::<Vec<_>>()
            .join(",");
        JsString::from(format!(
            "{} {} * * {days}",
            number(&schedule["minute"])?,
            number(&schedule["hour"])?
        ))
    } else {
        schedule["expression"]
            .as_js_string()
            .context("Validated automation cron expression")?
            .clone()
    };
    let zone = timezone(
        schedule["timeZone"]
            .as_str()
            .context("Validated automation time zone")?,
    )?;
    if expression
        .units()
        .iter()
        .position(|u| *u == 0x3a)
        .is_some_and(|i| i > 0)
    {
        return super::cron_date::once(&expression, &zone, after);
    }
    let pattern =
        super::cron::parse(&expression).map_err(|e| anyhow::anyhow!(e.lossy().into_owned()))?;
    super::cron_date::next(&pattern, &zone, after)
}

pub(crate) fn cron_error(expression: &JsString, zone: &jiff::tz::TimeZone) -> Option<JsString> {
    if expression
        .units()
        .iter()
        .position(|u| *u == 0x3a)
        .is_some_and(|i| i > 0)
    {
        return super::cron_date::once_fields(expression, zone)
            .err()
            .map(|_| JsString::from("Invalid ISO8601 passed to timezone parser."));
    }
    super::cron::parse(expression).err()
}

pub fn first(schedule: &Value, now: i64) -> Result<Option<i64>> {
    if schedule["kind"] == "interval"
        && let Some(start) = start(schedule).filter(|start| *start >= now)
    {
        return Ok(Some(start));
    }
    next(schedule, now)
}
