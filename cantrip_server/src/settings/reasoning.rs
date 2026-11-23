use crate::wire::{JsString, Value, coercion};

#[derive(Debug)]
pub struct MetadataError;
impl std::fmt::Display for MetadataError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Model reasoning metadata operation failed.")
    }
}
impl std::error::Error for MetadataError {}

// Access properties at the point where the source operation evaluates them.
// Non-null primitives are boxed by JavaScript; null/undefined throw instead.
fn property<'a>(value: Option<&'a Value>, name: &str) -> Result<Option<&'a Value>, MetadataError> {
    match value {
        None | Some(Value::Null) => Err(MetadataError),
        Some(value) => Ok(value.get(name)),
    }
}
fn catalog(runtime: &Value) -> Result<Option<&Value>, MetadataError> {
    property(property(Some(runtime), "model")?, "catalog")
}
fn nullish(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_null)
}
fn advertised(runtime: &Value) -> Result<Option<&Value>, MetadataError> {
    let catalog = catalog(runtime)?;
    if nullish(catalog) {
        return Ok(None);
    }
    let options = property(catalog, "supportedReasoningEfforts")?;
    Ok(if nullish(options) { None } else { options })
}
fn array_options(runtime: &Value) -> Result<&[Value], MetadataError> {
    match advertised(runtime)? {
        None => Ok(&[]),
        Some(Value::Array(values)) => Ok(values),
        _ => Err(MetadataError),
    }
}
// Map/Set use SameValueZero; predicate comparisons use ===. Object-valued
// malformed effort keys retain identity rather than structural equality.
fn key_equal(left: Option<&Value>, right: Option<&Value>, map: bool) -> bool {
    match (left, right) {
        (Some(left @ (Value::Object(_) | Value::Array(_))), Some(right)) => {
            std::ptr::eq(left, right)
        }
        (Some(Value::Number(left)), Some(Value::Number(right))) => {
            left == right || (map && left.is_nan() && right.is_nan())
        }
        _ => left == right,
    }
}
fn supports(runtime: &Value, effort: &Value) -> Result<bool, MetadataError> {
    let catalog = catalog(runtime)?;
    if !coercion::truthy(catalog) {
        return Ok(false);
    }
    let Some(Value::Array(options)) = property(catalog, "supportedReasoningEfforts")? else {
        return Err(MetadataError);
    };
    for option in options {
        if key_equal(property(Some(option), "effort")?, Some(effort), false) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn state(
    model: &Value,
    effort: &Value,
    runtimes: &[Value],
    configuration: bool,
) -> Result<Value, MetadataError> {
    let mut selected: Vec<(Option<&Value>, Value)> = Vec::new();
    if configuration {
        for runtime in runtimes {
            match advertised(runtime)? {
                None => {}
                Some(Value::Array(options)) => {
                    for option in options {
                        let key = property(Some(option), "effort")?;
                        if !selected
                            .iter()
                            .any(|(known, _)| key_equal(*known, key, true))
                        {
                            selected.push((key, option.clone()));
                        }
                    }
                }
                Some(Value::String(text)) => {
                    // Strings are iterable. Every yielded character has an
                    // undefined effort, so the first code point wins that key.
                    if !text.is_empty() && !selected.iter().any(|(key, _)| key.is_none()) {
                        let units = text.units();
                        let end = if (0xd800..=0xdbff).contains(&units[0])
                            && units
                                .get(1)
                                .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
                        {
                            2
                        } else {
                            1
                        };
                        selected.push((None, Value::String(JsString::new(units[..end].to_vec()))));
                    }
                }
                _ => return Err(MetadataError),
            }
        }
    } else if let Some(first) = runtimes.first() {
        for option in array_options(first)? {
            let mut keep = true;
            for runtime in runtimes {
                let mut matched = false;
                for candidate in array_options(runtime)? {
                    let candidate_key = property(Some(candidate), "effort")?;
                    let option_key = property(Some(option), "effort")?;
                    if key_equal(candidate_key, option_key, false) {
                        matched = true;
                        break;
                    }
                }
                if !matched {
                    keep = false;
                    break;
                }
            }
            if keep {
                selected.push((property(Some(option), "effort")?, option.clone()));
            }
        }
    }
    let supported = coercion::truthy(Some(effort))
        && selected
            .iter()
            .any(|(key, _)| key_equal(*key, Some(effort), true));
    let mut mandatory = !runtimes.is_empty();
    for runtime in runtimes {
        let catalog = catalog(runtime)?;
        if nullish(catalog) || property(catalog, "reasoningMandatory")? != Some(&Value::Bool(true))
        {
            mandatory = false;
            break;
        }
    }
    let mut incomplete = false;
    for runtime in runtimes {
        let catalog = catalog(runtime)?;
        if !coercion::truthy(catalog)
            || property(catalog, "supportsReasoning")? == Some(&Value::Null)
        {
            incomplete = true;
            break;
        }
    }
    Ok(Value::object([
        ("modelId", model.clone()),
        (
            "reasoningEffort",
            if supported {
                effort.clone()
            } else {
                Value::Null
            },
        ),
        (
            "options",
            Value::Array(selected.into_iter().map(|(_, value)| value).collect()),
        ),
        ("reasoningMandatory", Value::Bool(mandatory)),
        ("incompleteMetadata", Value::Bool(incomplete)),
    ]))
}

pub fn prepare(runtimes: &[Value], requested: &Value) -> Result<Vec<Value>, MetadataError> {
    let mut prepared: Vec<_> = runtimes
        .iter()
        .map(|runtime| {
            let exact = !requested.is_null() && supports(runtime, requested)?;
            let applied = if exact {
                requested.clone()
            } else {
                Value::Null
            };
            let mut runtime = runtime.clone();
            runtime["model"]["reasoningEffort"] = applied.clone();
            Ok(Value::object([
                ("adjusted", Value::Bool(!requested.is_null() && !exact)),
                ("appliedReasoningEffort", applied),
                ("runtime", runtime),
            ]))
        })
        .collect::<Result<_, MetadataError>>()?;
    if !requested.is_null() {
        prepared.sort_by_key(|r| r["adjusted"] == true);
    }
    Ok(prepared)
}

#[derive(Debug)]
pub struct ConfigurationFailure(pub Value);
impl std::fmt::Display for ConfigurationFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.0["error"].as_js_string() {
            Some(value) => f.write_str(&value.lossy()),
            None => f.write_str("Model configuration failed."),
        }
    }
}
impl std::error::Error for ConfigurationFailure {}

fn failure(
    code: &str,
    message: impl Into<JsString>,
    field: Option<&str>,
    retryable: bool,
) -> anyhow::Error {
    ConfigurationFailure(Value::object([
        ("code", Value::String(code.into())),
        ("error", Value::String(message.into())),
        (
            "field",
            field
                .map(|v| Value::String(v.into()))
                .unwrap_or(Value::Null),
        ),
        ("retryable", Value::Bool(retryable)),
    ]))
    .into()
}

fn exact(runtimes: &[Value], requested: &Value, subagent: bool) -> anyhow::Result<Vec<Value>> {
    let exact: Vec<_> = prepare(runtimes, requested)?
        .into_iter()
        .filter(|r| r["adjusted"] != true)
        .collect();
    if !requested.is_null() && exact.is_empty() {
        let requested = coercion::string(requested).expect("reasoning effort value");
        let (prefix, suffix) = if subagent {
            (
                "The selected subagent model does not support ",
                " reasoning on a route compatible with the root model.",
            )
        } else {
            (
                "The selected root model does not support ",
                " reasoning on an available route.",
            )
        };
        let mut units: Vec<_> = prefix.encode_utf16().collect();
        units.extend_from_slice(requested.units());
        units.extend(suffix.encode_utf16());
        return Err(failure(
            if subagent {
                "subagent-reasoning-unsupported"
            } else {
                "root-reasoning-unsupported"
            },
            JsString::new(units),
            Some(if subagent {
                "subagentReasoningEffort"
            } else {
                "reasoningEffort"
            }),
            false,
        ));
    }
    Ok(exact)
}

pub fn same_provider(root: &Value, subagent: &Value) -> bool {
    root["provider"].get("id") == subagent["provider"].get("id")
        && root["provider"].get("accountId") == subagent["provider"].get("accountId")
}

pub fn resolve_pairs(
    configuration: &Value,
    roots: &[Value],
    subagents: &[Value],
    worker_connected: Option<bool>,
) -> anyhow::Result<Vec<Value>> {
    if worker_connected == Some(false) {
        return Err(failure(
            "worker-offline",
            "The project worker is offline. Reconnect it before changing or using this model configuration.",
            None,
            true,
        ));
    }
    if !coercion::truthy(configuration.get("modelId")) || roots.is_empty() {
        return Err(failure(
            "root-model-unavailable",
            "The selected root model has no route available on this worker.",
            Some("modelId"),
            true,
        ));
    }
    if !coercion::truthy(configuration.get("customSubagentModel")) {
        return Ok(exact(roots, &configuration["reasoningEffort"], false)?
            .into_iter()
            .map(|root| Value::object([("root", root), ("subagent", Value::Null)]))
            .collect());
    }
    if !coercion::truthy(configuration.get("subagentModelId")) || subagents.is_empty() {
        return Err(failure(
            "subagent-model-unavailable",
            "The selected subagent model has no route available on this worker.",
            Some("subagentModelId"),
            true,
        ));
    }
    let topology: Vec<_> = roots
        .iter()
        .filter_map(|root| {
            subagents
                .iter()
                .find(|candidate| same_provider(root, candidate))
                .map(|subagent| (root, subagent))
        })
        .collect();
    if topology.is_empty() {
        return Err(failure(
            "provider-route-incompatible",
            "The selected root and subagent models do not share an available provider route and account. Choose models served by the same provider identity.",
            Some("subagentModelId"),
            false,
        ));
    }
    let prepared_roots = exact(roots, &configuration["reasoningEffort"], false)?;
    // Account expansion can repeat route IDs. Match the source Map's last
    // value for a key without reordering the original topology pairs.
    let compatible: Vec<_> = topology
        .into_iter()
        .filter_map(|(root, subagent)| {
            prepared_roots
                .iter()
                .rev()
                .find(|r| r["runtime"].get("routeId") == root.get("routeId"))
                .map(|r| (r, subagent))
        })
        .collect();
    if compatible.is_empty() {
        return Err(failure(
            "root-reasoning-unsupported",
            "The selected root reasoning effort is not supported on a route compatible with the subagent model.",
            Some("reasoningEffort"),
            false,
        ));
    }
    let prepared_subagents = exact(subagents, &configuration["subagentReasoningEffort"], true)?;
    let pairs: Vec<_> = compatible
        .into_iter()
        .filter_map(|(root, subagent)| {
            prepared_subagents
                .iter()
                .rev()
                .find(|r| r["runtime"].get("routeId") == subagent.get("routeId"))
                .map(|r| Value::object([("root", root.clone()), ("subagent", r.clone())]))
        })
        .collect();
    if pairs.is_empty() {
        return Err(failure(
            "subagent-reasoning-unsupported",
            "The selected subagent reasoning effort is not supported on a route compatible with the root model.",
            Some("subagentReasoningEffort"),
            false,
        ));
    }
    Ok(pairs)
}
