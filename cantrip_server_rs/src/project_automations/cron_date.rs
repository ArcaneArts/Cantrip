//! Croner JS's civil traversal and Intl time-zone roundtrips, including its
//! year-3000 search boundary and earlier-fold behavior. See retained MIT license.
use super::cron::Pattern;
use crate::wire::{self, JsString};
use anyhow::{Context, Result};
use jiff::{Timestamp, tz::TimeZone};
pub(super) type Fields = [i64; 6]; // year, zero-based month, day, hour, minute, second
const DAY: i64 = 86_400_000;
const MONTH: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

fn utc(f: Fields) -> Result<i64> {
    let value = i128::from(
        wire::date_utc_milliseconds(f[0], f[1], f[2]).context("Cron date outside TimeClip")?,
    ) + i128::from((f[3] * 3600 + f[4] * 60 + f[5]) * 1000);
    anyhow::ensure!(
        value.abs() <= 8_640_000_000_000_000,
        "Cron date outside TimeClip"
    );
    Ok(value as i64)
}
fn utc_fields(ms: i64) -> Result<Fields> {
    let (y, m, d) = wire::date_utc_fields(ms).context("Cron date outside TimeClip")?;
    let c = ms.rem_euclid(DAY);
    Ok([y, m - 1, d, c / 3_600_000, c / 60_000 % 60, c / 1000 % 60])
}
fn local(ms: i64, zone: &TimeZone, intl: bool) -> Result<Fields> {
    let f = utc_fields(ms)?;
    let year = if f[0] > 9998 {
        f[0].rem_euclid(400) + 2400
    } else if f[0] < -9998 {
        f[0].rem_euclid(400) - 9600
    } else {
        f[0]
    };
    let representative = if year == f[0] {
        ms
    } else {
        utc([year, f[1], f[2], f[3], f[4], f[5]])?
    };
    let value = Timestamp::from_millisecond(representative)?.to_zoned(zone.clone());
    let year = i64::from(value.year()) + f[0] - year;
    Ok([
        if intl && year <= 0 { 1 - year } else { year },
        i64::from(value.month()) - 1,
        i64::from(value.day()),
        i64::from(value.hour()),
        i64::from(value.minute()),
        i64::from(value.second()),
    ])
}
fn from_tz(f: Fields, zone: &TimeZone) -> Result<i64> {
    let t = utc(f)?;
    let r = local(t, zone, true)?;
    let first = t + utc(f)? - utc(r)?;
    let h = local(first, zone, true)?;
    if h == f {
        let earlier = first - 3_600_000;
        return Ok(if local(earlier, zone, true)? == f {
            earlier
        } else {
            first
        });
    }
    let second = first + utc(f)? - utc(h)?;
    Ok(if local(second, zone, true)? == f {
        second
    } else {
        first.max(second)
    })
}
pub(super) fn once_fields(expression: &JsString, zone: &TimeZone) -> Result<Fields> {
    let parsed = wire::date_milliseconds(expression)
        .context("Invalid ISO8601 passed to timezone parser.")?;
    let explicit = expression
        .units()
        .iter()
        .skip(9)
        .any(|u| matches!(*u, 0x5a | 0x2b | 0x2d));
    let fields = if explicit {
        utc_fields(parsed)?
    } else {
        local(parsed, crate::environment::timezone(), false)?
    };
    let utc = TimeZone::UTC;
    let timestamp = from_tz(fields, if explicit { &utc } else { zone })?;
    local(timestamp, zone, true)
}
pub(super) fn once(expression: &JsString, zone: &TimeZone, after: i64) -> Result<Option<i64>> {
    let once = from_tz(once_fields(expression, zone)?, zone)?;
    let after = from_tz(local(after, zone, true)?, zone)?;
    Ok((once > after).then_some(once))
}
fn last_day(year: i64, month: i64) -> Result<i64> {
    if month != 1 {
        return Ok(MONTH[month as usize]);
    }
    Ok(utc_fields(wire::date_utc_milliseconds(year, month + 1, 0).context("Cron month")?)?[2])
}
fn weekday(year: i64, month: i64, day: i64) -> Result<i64> {
    Ok((utc([year, month, day, 0, 0, 0])?.div_euclid(DAY) + 4).rem_euclid(7))
}
fn day_match(p: &Pattern, f: Fields, day: i64) -> Result<bool> {
    let last = last_day(f[0], f[1])?;
    let mut matched = p.fields[3][day as usize - 1] != 0;
    if !matched {
        for (i, bit) in p.nearest.iter().enumerate().filter(|(_, v)| **v != 0) {
            let _ = bit;
            let at = i as i64 + 1;
            if at > last {
                continue;
            }
            let nearest = match weekday(f[0], f[1], at)? {
                0 => {
                    if at == last {
                        at - 2
                    } else {
                        at + 1
                    }
                }
                6 => {
                    if at == 1 {
                        at + 2
                    } else {
                        at - 1
                    }
                }
                _ => at,
            };
            if day == nearest {
                matched = true;
                break;
            }
        }
    }
    if p.last_weekday {
        let nearest = match weekday(f[0], f[1], last)? {
            0 => last - 2,
            6 => last - 1,
            _ => last,
        };
        matched |= day == nearest;
    }
    matched |= p.last && day == last;
    if !p.star_dow {
        let dow = (weekday(f[0], f[1], 1)? + day - 1) % 7;
        let mask = p.fields[5][dow as usize];
        let selected = mask & (1 << ((day - 1) / 7)) != 0 || mask & 32 != 0 && day + 7 > last;
        matched = if p.and || p.star_dom {
            matched && selected
        } else {
            matched || selected
        };
    }
    Ok(matched)
}
fn normalize(f: &mut Fields) -> Result<bool> {
    if !(0..=11).contains(&f[1])
        || f[2] < 1
        || f[2] > MONTH[f[1] as usize]
        || f[3] > 59
        || f[4] > 59
        || f[5] > 59
        || f[3] < 0
        || f[4] < 0
        || f[5] < 0
    {
        *f = utc_fields(utc(*f)?)?;
        return Ok(true);
    }
    Ok(false)
}
pub(super) fn next(p: &Pattern, zone: &TimeZone, after: i64) -> Result<Option<i64>> {
    let mut f = local(after, zone, true)?;
    f[5] += 1;
    normalize(&mut f)?;
    let field = [1, 2, 3, 4, 5];
    let masks = [4, 3, 2, 1, 0];
    let offsets = [0, -1, 0, 0, 0];
    let mut stage = 0usize;
    loop {
        let index = field[stage];
        let offset = offsets[stage];
        let previous = f[index];
        let mut selected = None;
        for value in (f[index] + offset)..p.fields[masks[stage]].len() as i64 {
            if value < 0 {
                continue;
            }
            if if stage == 1 {
                day_match(p, f, value - offset)?
            } else {
                p.fields[masks[stage]][value as usize] != 0
            } {
                selected = Some(value - offset);
                break;
            }
        }
        if selected != Some(previous) {
            for lower in stage + 1..5 {
                f[field[lower]] = -offsets[lower];
            }
            let Some(value) = selected else {
                f[index] = -offset;
                f[if stage == 0 { 0 } else { field[stage - 1] }] += 1;
                normalize(&mut f)?;
                stage = 0;
                continue;
            };
            f[index] = value;
            if normalize(&mut f)? {
                stage = stage.saturating_sub(1);
                continue;
            }
        }
        stage += 1;
        if stage == 5 {
            return from_tz(f, zone).map(Some);
        }
        if f[0] >= 3000 {
            return Ok(None);
        }
    }
}
