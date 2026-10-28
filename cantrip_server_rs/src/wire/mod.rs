//! Native execution of generated protocol contracts. JavaScript is used only
//! by the development exporter/oracle; requests execute these Rust operations.
pub(crate) mod coercion;
mod js_date;
mod json_contract;
mod json_text;
pub use json_text::parse_json_text;
pub(crate) mod live;
mod projects;
mod refinements;
pub mod value;
mod worker_command;
mod worker_contract;
pub use value::{JsString, Value};
use value::{Object, json};

use serde::Deserialize;
use serde_json::Map;
use std::{collections::HashMap, sync::OnceLock};

#[derive(Debug)]
pub enum ValidationError {
    Invalid(Vec<Value>),
    Operation,
}
impl ValidationError {
    pub fn body(self) -> Value {
        match self {
            Self::Invalid(issues) => json!({"error":"Invalid request body","issues":issues}),
            Self::Operation => Value::Null,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Check {
    #[serde(rename = "check")]
    kind: String,
    #[serde(default)]
    message_after_path: bool,
    #[serde(default)]
    format: String,
    #[serde(default)]
    minimum: Value,
    #[serde(default)]
    maximum: Value,
    #[serde(default)]
    length: Value,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    inclusive: bool,
    #[serde(default)]
    abort: bool,
    #[serde(default)]
    when: Option<String>,
    #[serde(default)]
    pattern: Option<String>,
    #[serde(default)]
    flags: String,
    #[serde(default)]
    display_pattern: String,
    #[serde(default)]
    tag: String,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    path: Vec<Value>,
    #[serde(skip)]
    compiled: Option<regress::Regex>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Node {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    optional_in: bool,
    #[serde(default)]
    optional_out: bool,
    #[serde(default)]
    shape: Map<String, serde_json::Value>,
    #[serde(default)]
    inner_type: Option<usize>,
    #[serde(default)]
    element: Option<usize>,
    #[serde(default)]
    key_type: Option<usize>,
    #[serde(default)]
    value_type: Option<usize>,
    #[serde(default)]
    catchall: Option<usize>,
    #[serde(default)]
    options: Vec<usize>,
    #[serde(default)]
    items: Vec<usize>,
    #[serde(default)]
    rest: Option<usize>,
    #[serde(default)]
    discriminator: Option<String>,
    #[serde(default)]
    values: Vec<Value>,
    #[serde(default)]
    default_value: Value,
    #[serde(default)]
    coerce: bool,
    #[serde(default)]
    checks: Vec<Check>,
    #[serde(default, rename = "in")]
    input: Option<usize>,
    #[serde(default, rename = "out")]
    output: Option<usize>,
    #[serde(default)]
    transform_tag: String,
}
#[derive(Deserialize)]
struct Contracts {
    roots: HashMap<String, usize>,
    nodes: Vec<Node>,
}

struct Parsed {
    value: Option<Value>,
    issues: Vec<Value>,
    aborted: bool,
}
impl Parsed {
    fn new(value: Option<Value>) -> Self {
        Self {
            value,
            issues: Vec::new(),
            aborted: false,
        }
    }
    fn issue(&mut self, value: Value, path: &[Value], message: String, abort: bool) {
        self.issue_message(value, path, message.into(), abort);
    }
    fn issue_message(&mut self, mut value: Value, path: &[Value], message: JsString, abort: bool) {
        if value["code"] == "custom" {
            value["message"] = json!(message);
            value["path"] = json!(path);
        } else {
            value["path"] = json!(path);
            value["message"] = json!(message);
        }
        self.issues.push(value);
        self.aborted |= abort;
    }
    fn invalid(&mut self, expected: &str, path: &[Value]) {
        self.issue(
            json!({"expected":expected,"code":"invalid_type"}),
            path,
            format!(
                "Invalid input: expected {expected}, received {}",
                received(self.value.as_ref())
            ),
            true,
        );
    }
    fn merge(&mut self, other: Parsed) {
        self.aborted |= other.aborted;
        self.issues.extend(other.issues);
    }
}

fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}
fn path_with(path: &[Value], key: Value) -> Vec<Value> {
    let mut result = path.to_vec();
    result.push(key);
    result
}
fn numeric(value: &Value) -> f64 {
    coercion::number(Some(value)).expect("numeric protocol bound")
}
fn display(value: &Value) -> String {
    match value {
        Value::String(value) => format!("\"{value}\""),
        _ => coercion::string(value)
            .expect("protocol literal")
            .to_string(),
    }
}

fn contracts() -> &'static Contracts {
    static CONTRACTS: OnceLock<Contracts> = OnceLock::new();
    CONTRACTS.get_or_init(|| {
        let mut contracts: Contracts =
            serde_json::from_str(include_str!("../../contracts/security.json"))
                .expect("embedded protocol contracts");
        for node in &mut contracts.nodes {
            for check in &mut node.checks {
                if let Some(pattern) = &check.pattern {
                    check.compiled = Some(
                        regress::Regex::with_flags(pattern, check.flags.as_str())
                            .expect("compiled protocol regex"),
                    );
                }
            }
        }
        contracts
    })
}

pub fn parse(name: &str, input: Option<&Value>) -> Result<Value, ValidationError> {
    let contracts = contracts();
    let Some(id) = contracts.roots.get(name) else {
        return Err(ValidationError::Operation);
    };
    let result = contracts.run(*id, input, &[])?;
    if result.issues.is_empty() {
        Ok(result.value.unwrap_or(Value::Null))
    } else {
        Err(ValidationError::Invalid(result.issues))
    }
}

/// Date values supplied by PostgreSQL retain Node's Date.parse/TimeClip domain.
pub(crate) fn date_milliseconds(value: &JsString) -> Option<i64> {
    js_date::parse(value)
}

pub(crate) fn date_iso_milliseconds(value: i64) -> Option<String> {
    js_date::iso_milliseconds(value)
}

pub(crate) fn date_utc_fields(value: i64) -> Option<(i64, i64, i64)> {
    js_date::utc_fields(value)
}

pub(crate) fn date_utc_milliseconds(year: i64, month: i64, day: i64) -> Option<i64> {
    js_date::utc_milliseconds(year, month, day)
}

impl Contracts {
    fn run(
        &self,
        id: usize,
        input: Option<&Value>,
        path: &[Value],
    ) -> Result<Parsed, ValidationError> {
        let node = &self.nodes[id];
        let mut result = Parsed::new(input.cloned());
        match node.kind.as_str() {
            "optional" if input.is_none() => {}
            "nullable" if input.is_some_and(Value::is_null) => {}
            "default" if input.is_none() => result.value = Some(node.default_value.clone()),
            "prefault" if input.is_none() => {
                result = self.run(
                    node.inner_type.expect("prefault contract"),
                    Some(&node.default_value),
                    path,
                )?;
            }
            "optional" | "nullable" | "default" | "prefault" | "readonly" | "forward" => {
                result = self.run(node.inner_type.expect("inner contract"), input, path)?
            }
            "pipe" => {
                result = self.run(node.input.expect("input contract"), input, path)?;
                if !result.issues.is_empty() {
                    result.aborted = true;
                } else {
                    result = self.run(
                        node.output.expect("output contract"),
                        result.value.as_ref(),
                        path,
                    )?;
                }
            }
            "transform" => live::transform(&node.transform_tag, &mut result, path)?,
            "string" => {
                if node.coerce {
                    result.value = Some(json!(match input {
                        Some(input) =>
                            coercion::string(input).map_err(|_| ValidationError::Operation)?,
                        None => "undefined".into(),
                    }));
                }
                if !result.value.as_ref().is_some_and(Value::is_string) {
                    result.invalid("string", path);
                }
            }
            "number" => {
                if node.coerce || input.is_some_and(Value::is_number) {
                    match coercion::number(input) {
                        Ok(value) if value.is_finite() => {
                            result.value = Some(coercion::json_number(value))
                        }
                        Ok(value) => {
                            let received = if value.is_nan() { "NaN" } else { "number" };
                            result.issue(json!({"expected":"number","code":"invalid_type","received":if value.is_nan(){"NaN"}else{"Infinity"}}),path,format!("Invalid input: expected number, received {received}"),true);
                        }
                        Err(_) => result.invalid("number", path),
                    }
                } else {
                    result.invalid("number", path);
                }
            }
            "boolean" => {
                if node.coerce {
                    result.value = Some(json!(coercion::truthy(input)));
                }
                if !result.value.as_ref().is_some_and(Value::is_boolean) {
                    result.invalid("boolean", path);
                }
            }
            "null" => {
                if !input.is_some_and(Value::is_null) {
                    result.invalid("null", path);
                }
            }
            "never" => result.invalid("never", path),
            "unknown" => {}
            "json" => result = json_contract::parse(input, path),
            "literal" | "enum" => {
                if !input.is_some_and(|value| node.values.contains(value)) {
                    let values = node.values.iter().map(display).collect::<Vec<_>>();
                    let message = if values.len() == 1 {
                        format!("Invalid input: expected {}", values[0])
                    } else {
                        format!("Invalid option: expected one of {}", values.join("|"))
                    };
                    result.issue(
                        json!({"code":"invalid_value","values":node.values}),
                        path,
                        message,
                        true,
                    );
                }
            }
            "object" => {
                if let Some(object) = input.and_then(Value::as_object) {
                    let mut output = Object::new();
                    for (key, id) in &node.shape {
                        let schema_id = id.as_u64().unwrap() as usize;
                        let present = object.contains_key(key.as_str());
                        let mut child = self.run(
                            schema_id,
                            object.get(key.as_str()),
                            &path_with(path, json!(key)),
                        )?;
                        let schema = &self.nodes[schema_id];
                        if !present && schema.optional_in && schema.optional_out {
                            child.issues.clear();
                            child.aborted = false;
                        }
                        if !present && !schema.optional_in {
                            if child.issues.is_empty() {
                                child.issue(
                                    json!({"code":"invalid_type","expected":"nonoptional"}),
                                    &path_with(path, json!(key)),
                                    "Invalid input: expected nonoptional, received undefined"
                                        .into(),
                                    true,
                                );
                            }
                            child.value = None;
                        }
                        if let Some(value) = &child.value {
                            output.insert(key.clone().into(), value.clone());
                        }
                        result.merge(child);
                    }
                    let extra: Vec<_> = coercion::keys(object)
                        .into_iter()
                        .filter(|key| key.as_str() != Some("__proto__"))
                        .filter(|key| !key.as_str().is_some_and(|key| node.shape.contains_key(key)))
                        .collect();
                    if let Some(catchall) = node.catchall {
                        if self.nodes[catchall].kind == "never" {
                            if !extra.is_empty() {
                                let message = JsString::join_quoted(
                                    &format!(
                                        "Unrecognized {}: ",
                                        if extra.len() == 1 { "key" } else { "keys" }
                                    ),
                                    &extra,
                                );
                                result.issue_message(
                                    json!({"code":"unrecognized_keys","keys":extra}),
                                    path,
                                    message,
                                    true,
                                );
                            }
                        } else {
                            for key in extra {
                                let child = self.run(
                                    catchall,
                                    object.get(key),
                                    &path_with(path, json!(key)),
                                )?;
                                if let Some(value) = &child.value {
                                    output.insert(key.clone(), value.clone());
                                }
                                result.merge(child);
                            }
                        }
                    }
                    result.value = Some(Value::Object(output));
                } else {
                    result.invalid("object", path);
                }
            }
            "array" => {
                if let Some(array) = input.and_then(Value::as_array) {
                    let mut output = Vec::new();
                    for (index, value) in array.iter().enumerate() {
                        let child = self.run(
                            node.element.expect("array element"),
                            Some(value),
                            &path_with(path, json!(index)),
                        )?;
                        output.push(child.value.clone().unwrap_or(Value::Null));
                        result.merge(child);
                    }
                    result.value = Some(json!(output));
                } else {
                    result.invalid("array", path);
                }
            }
            "record" => result = self.record(node, input, path)?,
            "tuple" => result = self.tuple(node, input, path)?,
            "union" => result = self.union(node, input, path)?,
            _ => return Err(ValidationError::Operation),
        }
        for check in &node.checks {
            if check.when.is_some() {
                if coercion::length(result.value.as_ref())
                    .map_err(|_| ValidationError::Operation)?
                    .is_none()
                {
                    continue;
                }
            } else if result.aborted {
                continue;
            }
            let previous_issues = result.issues.len();
            self.check(check, &mut result, path)?;
            if check.kind != "refinement"
                && let Some(message) = &check.message
            {
                for issue in &mut result.issues[previous_issues..] {
                    issue["message"] = json!(message);
                }
            }
        }
        Ok(result)
    }
    fn tuple(
        &self,
        node: &Node,
        input: Option<&Value>,
        path: &[Value],
    ) -> Result<Parsed, ValidationError> {
        let mut result = Parsed::new(input.cloned());
        let Some(array) = input.and_then(Value::as_array) else {
            result.invalid("tuple", path);
            return Ok(result);
        };
        let minimum = node
            .items
            .iter()
            .rposition(|id| !self.nodes[*id].optional_in)
            .map_or(0, |index| index + 1);
        if array.len() < minimum {
            result.issue(
                json!({"code":"too_small","minimum":minimum,"inclusive":true,"origin":"array"}),
                path,
                format!("Too small: expected array to have >={minimum} items"),
                true,
            );
        } else if node.rest.is_none() && array.len() > node.items.len() {
            let maximum = node.items.len();
            result.issue(
                json!({"code":"too_big","maximum":maximum,"inclusive":true,"origin":"array"}),
                path,
                format!("Too big: expected array to have <={maximum} items"),
                true,
            );
        } else {
            let mut output = Vec::new();
            for (index, id) in node.items.iter().enumerate() {
                let child = self.run(*id, array.get(index), &path_with(path, json!(index)))?;
                if index < array.len() || child.value.is_some() {
                    output.resize(index + 1, Value::Null);
                    output[index] = child.value.clone().unwrap_or(Value::Null);
                }
                result.merge(child);
            }
            if let Some(rest) = node.rest {
                for (index, value) in array.iter().enumerate().skip(node.items.len()) {
                    let child = self.run(rest, Some(value), &path_with(path, json!(index)))?;
                    output.push(child.value.clone().unwrap_or(Value::Null));
                    result.merge(child);
                }
            }
            result.value = Some(Value::Array(output));
        }
        Ok(result)
    }
    fn discriminator_values(&self, id: usize) -> Result<Vec<Option<Value>>, ValidationError> {
        let node = &self.nodes[id];
        match node.kind.as_str() {
            "literal" | "enum" => Ok(node.values.iter().cloned().map(Some).collect()),
            "optional" => {
                let mut values =
                    self.discriminator_values(node.inner_type.expect("optional discriminator"))?;
                values.push(None);
                Ok(values)
            }
            _ => Err(ValidationError::Operation),
        }
    }
    fn union(
        &self,
        node: &Node,
        input: Option<&Value>,
        path: &[Value],
    ) -> Result<Parsed, ValidationError> {
        let mut result = Parsed::new(input.cloned());
        if let Some(key) = &node.discriminator {
            let Some(object) = input.and_then(Value::as_object) else {
                result.issue(
                    json!({"code":"invalid_type","expected":"object"}),
                    path,
                    format!(
                        "Invalid input: expected object, received {}",
                        received(input)
                    ),
                    true,
                );
                return Ok(result);
            };
            let mut values = Vec::new();
            for id in &node.options {
                let option = &self.nodes[*id];
                let candidates =
                    self.discriminator_values(option.shape[key].as_u64().unwrap() as usize)?;
                if candidates
                    .iter()
                    .any(|candidate| candidate.as_ref() == object.get(key))
                {
                    return self.run(*id, input, path);
                }
                values.extend(candidates);
            }
            let message = format!(
                "Invalid discriminator value. Expected {}",
                values
                    .iter()
                    .map(|v| match v {
                        Some(v) =>
                            format!("'{}'", coercion::string(v).expect("discriminator literal")),
                        None => "'undefined'".into(),
                    })
                    .collect::<Vec<_>>()
                    .join(" | ")
            );
            result.issue(json!({"code":"invalid_union","errors":Vec::<Value>::new(),"note":"No matching discriminator","discriminator":key,"options":values}),&path_with(path,json!(key)),message,true);
            return Ok(result);
        }
        let mut alternatives = Vec::new();
        for id in &node.options {
            let alternative = self.run(*id, input, &[])?;
            if alternative.issues.is_empty() {
                return Ok(alternative);
            }
            alternatives.push(alternative);
        }
        if alternatives.iter().filter(|p| !p.aborted).count() == 1 {
            let mut chosen = alternatives.into_iter().find(|p| !p.aborted).unwrap();
            for issue in &mut chosen.issues {
                let mut prefixed = path.to_vec();
                prefixed.extend(issue["path"].as_array().unwrap().iter().cloned());
                issue["path"] = json!(prefixed);
            }
            return Ok(chosen);
        }
        result.issue(json!({"code":"invalid_union","errors":alternatives.into_iter().map(|p|p.issues).collect::<Vec<_>>()}),path,"Invalid input".into(),true);
        Ok(result)
    }
    fn record(
        &self,
        node: &Node,
        input: Option<&Value>,
        path: &[Value],
    ) -> Result<Parsed, ValidationError> {
        let mut result = Parsed::new(input.cloned());
        let Some(object) = input.and_then(Value::as_object) else {
            result.invalid("record", path);
            return Ok(result);
        };
        let key_type = node.key_type.expect("record key");
        let value_type = node.value_type.expect("record value");
        let mut output = Object::new();
        let finite = &self.nodes[key_type].values;
        let keys = if finite.is_empty() {
            coercion::keys(object)
                .into_iter()
                .filter(|key| key.as_str() != Some("__proto__"))
                .cloned()
                .collect::<Vec<_>>()
        } else {
            finite
                .iter()
                .map(|v| v.as_js_string().unwrap().clone())
                .collect()
        };
        for key in keys {
            let checked = self.run(key_type, Some(&json!(key)), &[])?;
            if !checked.issues.is_empty() {
                result.issue(
                    json!({"code":"invalid_key","origin":"record","issues":checked.issues}),
                    &path_with(path, json!(key)),
                    "Invalid key in record".into(),
                    true,
                );
                continue;
            }
            let child = self.run(value_type, object.get(&key), &path_with(path, json!(key)))?;
            if let Some(value) = &child.value {
                output.insert(key, value.clone());
            }
            result.merge(child);
        }
        if !finite.is_empty() {
            let extra: Vec<_> = coercion::keys(object)
                .into_iter()
                .filter(|key| !finite.iter().any(|v| v.as_js_string() == Some(*key)))
                .collect();
            if !extra.is_empty() {
                result.issue_message(
                    json!({"code":"unrecognized_keys","keys":extra}),
                    path,
                    JsString::join_quoted(
                        &format!(
                            "Unrecognized {}: ",
                            if extra.len() == 1 { "key" } else { "keys" }
                        ),
                        &extra,
                    ),
                    true,
                );
            }
        }
        result.value = Some(Value::Object(output));
        Ok(result)
    }
    fn check(
        &self,
        check: &Check,
        result: &mut Parsed,
        path: &[Value],
    ) -> Result<(), ValidationError> {
        match check.kind.as_str() {
            "trim" => {
                if let Some(value) = result.value.as_ref().and_then(Value::as_js_string) {
                    result.value = Some(Value::String(value.trim()));
                }
            }
            "lowercase" => {
                if let Some(value) = result.value.as_ref().and_then(Value::as_js_string) {
                    result.value = Some(Value::String(value.lowercase()));
                }
            }
            "min_length" | "max_length" | "length_equals" => {
                let Some(length) = coercion::length(result.value.as_ref())
                    .map_err(|_| ValidationError::Operation)?
                else {
                    return Ok(());
                };
                let (bound, big, failed, exact) = match check.kind.as_str() {
                    "min_length" => (
                        check.minimum.clone(),
                        false,
                        length.number.is_nan() || length.number < numeric(&check.minimum),
                        false,
                    ),
                    "max_length" => (
                        check.maximum.clone(),
                        true,
                        length.number.is_nan() || length.number > numeric(&check.maximum),
                        false,
                    ),
                    _ => (
                        check.length.clone(),
                        length.number > numeric(&check.length),
                        !length.numeric || length.number != numeric(&check.length),
                        true,
                    ),
                };
                if failed {
                    let mut issue =
                        json!({"origin":length.origin,"code":if big{"too_big"}else{"too_small"}});
                    issue[if big { "maximum" } else { "minimum" }] = bound.clone();
                    issue["inclusive"] = json!(true);
                    if exact {
                        issue["exact"] = json!(true)
                    }
                    let sizing = match length.origin {
                        "string" => "have",
                        "array" => "have",
                        _ => "be",
                    };
                    let unit = match length.origin {
                        "string" => " characters",
                        "array" => " items",
                        _ => "",
                    };
                    result.issue(
                        issue,
                        path,
                        format!(
                            "Too {}: expected {} to {sizing} {}{bound}{unit}",
                            if big { "big" } else { "small" },
                            length.origin,
                            if big { "<=" } else { ">=" }
                        ),
                        check.abort,
                    );
                }
            }
            "number_format" => {
                let value = numeric(result.value.as_ref().unwrap());
                if check.format.contains("int") && value.fract() != 0.0 {
                    result.issue(
                        json!({"expected":"int","format":check.format,"code":"invalid_type"}),
                        path,
                        "Invalid input: expected int, received number".into(),
                        true,
                    );
                } else if check.format == "safeint" && value.abs() > 9007199254740991.0 {
                    let big = value > 0.0;
                    let mut issue = json!({"code":if big{"too_big"}else{"too_small"}});
                    issue[if big { "maximum" } else { "minimum" }] = json!(if big {
                        9007199254740991_i64
                    } else {
                        -9007199254740991_i64
                    });
                    issue["note"] = json!("Integers must be within the safe integer range.");
                    issue["origin"] = json!("int");
                    issue["inclusive"] = json!(true);
                    result.issue(
                        issue,
                        path,
                        format!(
                            "Too {}: expected int to be {}{}",
                            if big { "big" } else { "small" },
                            if big { "<=" } else { ">=" },
                            if big {
                                9007199254740991_i64
                            } else {
                                -9007199254740991_i64
                            }
                        ),
                        check.abort,
                    );
                }
            }
            "greater_than" | "less_than" => {
                let value = numeric(result.value.as_ref().unwrap());
                let bound = numeric(&check.value);
                let big = check.kind == "less_than";
                let failed = if big {
                    if check.inclusive {
                        value > bound
                    } else {
                        value >= bound
                    }
                } else if check.inclusive {
                    value < bound
                } else {
                    value <= bound
                };
                if failed {
                    let mut issue =
                        json!({"origin":"number","code":if big{"too_big"}else{"too_small"}});
                    issue[if big { "maximum" } else { "minimum" }] = check.value.clone();
                    issue["inclusive"] = json!(check.inclusive);
                    result.issue(
                        issue,
                        path,
                        format!(
                            "Too {}: expected number to be {}{}{}",
                            if big { "big" } else { "small" },
                            if big { "<" } else { ">" },
                            if check.inclusive { "=" } else { "" },
                            check.value
                        ),
                        check.abort,
                    );
                }
            }
            "string_format" => {
                let value = result
                    .value
                    .as_ref()
                    .and_then(Value::as_js_string)
                    .expect("validated string");
                if check.format == "url" {
                    let trimmed = value.trim();
                    // Zod trims its output, while the URL constructor accepts
                    // a USVString. Preserve the original UTF-16 in the output.
                    if url::Url::parse(&trimmed.lossy()).is_ok() {
                        result.value = Some(Value::String(trimmed));
                    } else {
                        result.issue(
                            json!({"code":"invalid_format","format":"url"}),
                            path,
                            check
                                .message
                                .clone()
                                .unwrap_or_else(|| "Invalid URL".into()),
                            check.abort,
                        );
                    }
                    return Ok(());
                }
                if check
                    .compiled
                    .as_ref()
                    .expect("protocol regex")
                    .find_from_utf16(value.units(), 0)
                    .next()
                    .is_none()
                {
                    let format = check.format.as_str();
                    let label = match format {
                        "email" => "email address",
                        "uuid" => "UUID",
                        "datetime" => "ISO datetime",
                        other => other,
                    };
                    let message = check.message.clone().unwrap_or_else(|| {
                        if format == "regex" {
                            format!(
                                "Invalid string: must match pattern {}",
                                check.display_pattern
                            )
                        } else {
                            format!("Invalid {label}")
                        }
                    });
                    result.issue(json!({"origin":"string","code":"invalid_format","format":format,"pattern":check.display_pattern}),path,message,check.abort);
                }
            }
            "refinement" => {
                let before = result.issues.len();
                if check.path.is_empty() {
                    refinements::apply(&check.tag, result, path, check.message.as_deref())?;
                } else {
                    let mut configured = path.to_vec();
                    configured.extend_from_slice(&check.path);
                    refinements::apply(&check.tag, result, &configured, check.message.as_deref())?;
                }
                // Predicate messages are filled during Zod's finalization.
                // Callback field order is retained by the exported metadata.
                if check.message_after_path {
                    for issue in &mut result.issues[before..] {
                        if issue["code"] == "custom"
                            && let Value::Object(fields) = issue
                        {
                            let message = fields
                                .shift_remove("message")
                                .expect("custom issue message");
                            fields.insert("message".into(), message);
                        }
                    }
                }
            }
            _ => return Err(ValidationError::Operation),
        }
        Ok(())
    }
}
