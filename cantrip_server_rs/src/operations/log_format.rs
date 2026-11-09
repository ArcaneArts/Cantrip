//! Console presentation of sanitized records, independent of archive minimization.
use crate::wire::{JsString, Value, coercion};
use anyhow::{Result, anyhow};
fn join(parts: impl IntoIterator<Item = JsString>, separator: &str) -> JsString {
    let mut units = Vec::new();
    for (index, part) in parts.into_iter().enumerate() {
        if index > 0 {
            units.extend(separator.encode_utf16());
        }
        units.extend(part.units());
    }
    JsString::new(units)
}
fn cat(parts: impl IntoIterator<Item = JsString>) -> JsString {
    join(parts, "")
}
fn text(value: &str) -> JsString {
    value.into()
}
fn painted(value: JsString, color: u8, colors: bool) -> JsString {
    if colors {
        cat([text(&format!("\u{1b}[{color}m")), value, text("\u{1b}[0m")])
    } else {
        value
    }
}
fn space(unit: u16) -> bool {
    char::from_u32(unit as u32).is_some_and(crate::text::whitespace)
}
fn one_line(value: &JsString) -> JsString {
    let mut units = Vec::new();
    let mut pending = false;
    for &unit in value.units() {
        if space(unit) {
            pending = !units.is_empty();
        } else {
            if pending {
                units.push(32);
                pending = false;
            }
            units.push(unit);
        }
    }
    JsString::new(units)
}
fn primitive(value: &Value) -> Result<JsString> {
    if let Some(value) = value.as_js_string() {
        let value = one_line(value);
        return Ok(if value.units().iter().any(|u| space(*u)) {
            cat([text("“"), value, text("”")])
        } else {
            value
        });
    }
    coercion::string(value).map_err(|_| anyhow!("Cannot convert object to primitive value"))
}
fn field(prefix: &JsString, value: JsString) -> JsString {
    cat([prefix.clone(), text("="), value])
}
fn flatten(
    value: &Value,
    prefix: JsString,
    output: &mut Vec<JsString>,
    depth: usize,
) -> Result<()> {
    match value {
        Value::Array(values) => {
            let values = values.iter().map(primitive).collect::<Result<Vec<_>>>()?;
            output.push(field(
                &prefix,
                cat([text("["), join(values, ", "), text("]")]),
            ));
        }
        Value::Object(fields) => {
            let keys = coercion::keys(fields);
            if matches!(prefix.as_str(), Some("err" | "error"))
                && let Some(message) = fields
                    .get("message")
                    .filter(|v| v.as_js_string().is_some_and(|s| !s.is_empty()))
            {
                output.push(field(&text("error"), primitive(message)?));
                return Ok(());
            }
            if depth >= 2 {
                output.push(field(
                    &prefix,
                    cat([text("{"), join(keys.into_iter().cloned(), ", "), text("}")]),
                ));
                return Ok(());
            }
            for key in keys {
                if matches!(
                    key.as_str(),
                    Some(
                        "hostname"
                            | "level"
                            | "msg"
                            | "pid"
                            | "reqId"
                            | "time"
                            | "v"
                            | "stack"
                            | "type"
                    )
                ) {
                    continue;
                }
                let nested = if prefix.is_empty() {
                    key.clone()
                } else {
                    cat([prefix.clone(), text("."), key.clone()])
                };
                flatten(&fields[key], nested, output, depth + 1)?;
            }
        }
        _ => output.push(field(
            &if prefix.is_empty() {
                text("value")
            } else {
                prefix
            },
            primitive(value)?,
        )),
    }
    Ok(())
}
fn prefix(record: &Value, colors: bool) -> JsString {
    let system = record["system"].as_js_string().expect("record system");
    let color = match system.as_str() {
        Some("server") => 94,
        Some("worker") => 35,
        _ => 34,
    };
    let clock = record["timestamp"]
        .as_js_string()
        .and_then(crate::wire::date_milliseconds)
        .and_then(|at| jiff::Timestamp::from_millisecond(at).ok())
        .map(|at| at.to_zoned(crate::environment::timezone().clone()))
        .map_or_else(
            || "NaN:NaN".to_owned(),
            |at| format!("{:02}:{:02}", at.hour(), at.minute()),
        );
    cat([
        painted(cat([text("["), system.clone(), text("]")]), color, colors),
        text(" "),
        painted(text(&format!("{clock}:")), 90, colors),
    ])
}
pub fn service(record: &Value, colors: bool) -> Result<JsString> {
    let level = record["level"].as_str().unwrap_or("info");
    let color = match level {
        "error" | "fatal" => 31,
        "warn" => 33,
        _ => 90,
    };
    let label = match level {
        "info" => None,
        "fatal" => Some("FATAL"),
        "error" => Some("ERROR"),
        "warn" => Some("WARN"),
        "debug" => Some("DEBUG"),
        _ => Some("TRACE"),
    };
    let mut parts = vec![prefix(record, colors), text(" ")];
    if let Some(label) = label {
        parts.extend([painted(text(label), color, colors), text(" ")]);
    }
    parts.push(painted(
        one_line(record["message"].as_js_string().expect("record message")),
        if level == "info" { 97 } else { color },
        colors,
    ));
    let mut fields = vec![];
    if let Some(context) = record.get("context") {
        flatten(context, text(""), &mut fields, 0)?;
    }
    let suffix = if fields.is_empty() {
        text("")
    } else {
        cat([text(" · "), join(fields, " ")])
    };
    parts.push(painted(suffix, 90, colors));
    Ok(cat(parts))
}
pub fn service_with_undefined(record: &Value, colors: bool, fields: &[&str]) -> Result<JsString> {
    if fields.is_empty() {
        return service(record, colors);
    }
    let mut record = record.clone();
    if let Value::Object(context) = &mut record["context"] {
        for field in fields {
            if let Some(value) = context.get_mut(*field) {
                *value = Value::String("undefined".into());
            }
        }
    }
    service(&record, colors)
}
fn number(value: f64) -> JsString {
    coercion::string(&Value::Number(value)).expect("number primitive")
}
pub fn duration(value: f64) -> JsString {
    if !value.is_finite() || value < 0.0 {
        return text("?");
    }
    if value < 0.5 {
        cat([number((value * 1000.0).floor().max(1.0)), text("µs")])
    } else {
        cat([number(value.floor().max(1.0)), text("ms")])
    }
}
pub fn status_name(code: f64) -> &'static str {
    super::http_status_names::NAMES
        .iter()
        .find(|(n, _)| *n as f64 == code)
        .map_or("Unknown", |(_, name)| name)
}
pub fn http(record: &Value, colors: bool) -> JsString {
    let c = &record["context"];
    let code = c["statusCode"].as_f64().unwrap_or(f64::NAN);
    let status = cat([number(code), text(" "), text(status_name(code))]);
    cat([
        prefix(record, colors),
        text(" "),
        painted(
            c["method"].as_js_string().expect("HTTP method").clone(),
            34,
            colors,
        ),
        text(" "),
        painted(
            c["path"].as_js_string().expect("HTTP path").clone(),
            97,
            colors,
        ),
        text(" "),
        painted(text("->"), 90, colors),
        text(" "),
        painted(
            status,
            if code >= 500.0 {
                31
            } else if code >= 300.0 {
                33
            } else {
                32
            },
            colors,
        ),
        text(" "),
        painted(
            cat([
                text("("),
                duration(c["durationMs"].as_f64().unwrap_or(f64::NAN)),
                text(")"),
            ]),
            90,
            colors,
        ),
    ])
}
