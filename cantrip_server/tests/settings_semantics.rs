use anyhow::{Context, Result};
use cantrip_server::{
    settings::{
        agent_time::{self, Interval},
        enrichment,
    },
    wire::Value,
};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
};

struct Oracle(Option<Child>);
impl Drop for Oracle {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
fn date(value: &Value) -> Option<f64> {
    if value.is_null() {
        return None;
    }
    Some(
        value
            .as_f64()
            .filter(|v| v.is_finite() && v.abs() <= 8.64e15)
            .map(f64::trunc)
            .unwrap_or(f64::NAN),
    )
}
fn reasoning_outcome<T: serde::Serialize>(
    result: Result<T, cantrip_server::settings::reasoning::MetadataError>,
) -> Value {
    match result {
        Ok(value) => Value::from_serialize(&value),
        Err(_) => Value::object([("thrown", Value::String("TypeError".into()))]),
    }
}
fn run(case: &Value) -> Result<Value> {
    let input = &case["input"];
    Ok(match case["op"].as_str().context("semantic operation")? {
        "account-auth-status" => {
            match cantrip_server::settings::authentication::account_auth_status(
                input["kind"].as_str().context("provider kind")?,
                &input["account"],
            ) {
                Ok(value) => Value::object([("value", value)]),
                Err(cantrip_server::wire::ValidationError::Invalid(issues)) => {
                    Value::object([("issues", Value::Array(issues))])
                }
                Err(cantrip_server::wire::ValidationError::Operation) => Value::object([
                    ("thrown", Value::String("TypeError".into())),
                    (
                        "message",
                        Value::String("Cannot convert object to primitive value".into()),
                    ),
                ]),
            }
        }
        "time" => {
            let rows: Vec<_> = input["rows"]
                .as_array()
                .context("time rows")?
                .iter()
                .map(|row| {
                    (
                        Interval {
                            attempt_status: row["attemptStatus"].as_str().unwrap().into(),
                            started_at: date(&row["startedAt"]),
                            completed_at: date(&row["completedAt"]),
                        },
                        row["key"].as_js_string().cloned(),
                    )
                })
                .collect();
            let now = date(&input["now"]).unwrap_or(f64::NAN);
            let groups = agent_time::group(rows.iter().map(|(row, key)| (row, key.as_ref())), now);
            let groups = Value::Array(
                groups
                    .into_iter()
                    .map(|(key, summary)| {
                        Value::Array(vec![Value::String(key), Value::from_serialize(&summary)])
                    })
                    .collect(),
            );
            Value::object([
                (
                    "total",
                    Value::from_serialize(&agent_time::summarize(
                        &rows.into_iter().map(|row| row.0).collect::<Vec<_>>(),
                        now,
                    )),
                ),
                ("groups", groups),
            ])
        }
        "enrich" => {
            let catalog = &input["catalog"];
            let kind = input["kind"].as_str().context("provider kind")?;
            let aliases = if catalog.is_null() {
                vec![]
            } else {
                enrichment::aliases(catalog, kind)
                    .into_iter()
                    .map(Value::String)
                    .collect()
            };
            Value::object([
                ("aliases", Value::Array(aliases)),
                (
                    "catalog",
                    enrichment::enrich(
                        catalog,
                        kind,
                        input["candidates"]
                            .as_array()
                            .context("candidate catalogs")?,
                    ),
                ),
            ])
        }
        "hash" => {
            Value::String(cantrip_server::settings::catalog::metadata_snapshot(input)?.into())
        }
        "json" => Value::String(input.stringify().into()),
        "openrouter-json" => match cantrip_server::wire::parse_json_text(
            &input.as_js_string().context("JSON source text")?.lossy(),
        ) {
            Ok(value) => Value::object([("serialized", Value::String(value.stringify().into()))]),
            Err(error) => Value::object([("error", Value::String(error))]),
        },
        "openrouter-normalize" => cantrip_server::settings::openrouter::normalize_model(input),
        "openrouter-provider" => Value::Bool(cantrip_server::settings::openrouter::is_provider(
            input["kind"].as_str().context("provider kind")?,
            &input["baseUrl"]
                .as_js_string()
                .context("provider URL")?
                .lossy(),
        )),
        "ollama" | "chatgpt" | "grok" => {
            let (schema, normalize): (&str, fn(&Value) -> Value) =
                match case["op"].as_str().unwrap() {
                    "chatgpt" => (
                        "chatGptModelInventorySchema",
                        cantrip_server::settings::chatgpt::normalize_model,
                    ),
                    "grok" => (
                        "grokModelInventorySchema",
                        cantrip_server::settings::grok::normalize_model,
                    ),
                    _ => (
                        "ollamaModelInventorySchema",
                        cantrip_server::settings::ollama::normalize_model,
                    ),
                };
            match cantrip_server::wire::parse(schema, Some(input)) {
                Ok(inventory) => Value::object([(
                    "value",
                    Value::Array(
                        inventory["models"]
                            .as_array()
                            .context("normalized Ollama models")?
                            .iter()
                            .map(normalize)
                            .collect(),
                    ),
                )]),
                Err(cantrip_server::wire::ValidationError::Invalid(issues)) => Value::object([(
                    "error",
                    Value::String(Value::Array(issues).stringify_pretty().into()),
                )]),
                Err(cantrip_server::wire::ValidationError::Operation) => {
                    anyhow::bail!("Ollama inventory validation operation failed")
                }
            }
        }
        "grok-vision" => Value::Array(cantrip_server::settings::grok::enrich_vision(
            input["models"].as_array().context("Grok models")?,
            input["candidates"]
                .as_array()
                .context("public catalog candidates")?,
        )),
        "reasoning" => {
            let runtimes = input["runtimes"].as_array().context("reasoning runtimes")?;
            Value::object([
                (
                    "intersection",
                    reasoning_outcome(cantrip_server::settings::reasoning::state(
                        &input["modelId"],
                        &input["requested"],
                        runtimes,
                        false,
                    )),
                ),
                (
                    "union",
                    reasoning_outcome(cantrip_server::settings::reasoning::state(
                        &input["modelId"],
                        &input["requested"],
                        runtimes,
                        true,
                    )),
                ),
                (
                    "prepared",
                    reasoning_outcome(cantrip_server::settings::reasoning::prepare(
                        runtimes,
                        &input["requested"],
                    )),
                ),
            ])
        }
        "routing" => {
            let result = cantrip_server::settings::reasoning::resolve_pairs(
                &input["configuration"],
                input["rootRuntimes"].as_array().context("root runtimes")?,
                input["subagentRuntimes"]
                    .as_array()
                    .context("subagent runtimes")?,
                input["workerConnected"].as_bool(),
            );
            match result {
                Ok(pairs) => {
                    Value::object([("value", Value::Array(pairs)), ("failure", Value::Null)])
                }
                Err(error) => {
                    if let Some(failure) = error
                        .downcast_ref::<cantrip_server::settings::reasoning::ConfigurationFailure>(
                    ) {
                        Value::object([("value", Value::Null), ("failure", failure.0.clone())])
                    } else {
                        anyhow::ensure!(
                            error.is::<cantrip_server::settings::reasoning::MetadataError>(),
                            "unexpected routing error {error}"
                        );
                        Value::object([
                            ("value", Value::Null),
                            ("failure", Value::Null),
                            ("thrown", Value::String("TypeError".into())),
                        ])
                    }
                }
            }
        }
        "collate" => {
            let locale = input["locale"].as_str().context("collation locale")?;
            let collator = icu_collator::Collator::try_new(
                locale.parse::<icu_locale_core::Locale>()?.into(),
                icu_collator::options::CollatorOptions::default(),
            )?;
            let order = collator.compare_utf16_icu4c(
                input["left"].as_js_string().context("left key")?.units(),
                input["right"].as_js_string().context("right key")?.units(),
            );
            Value::from_serialize(&(order as i8))
        }
        "url" => match cantrip_server::settings::normalize_responses_base_url(
            &input.as_js_string().context("URL input")?.lossy(),
        ) {
            Ok(value) => Value::object([("value", Value::String(value.into()))]),
            Err(error) => Value::object([("error", Value::String(error.to_string().into()))]),
        },
        _ => anyhow::bail!("unknown semantic case"),
    })
}
#[test]
fn settings_analytics_and_enrichment_match_actual_node() -> Result<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_owned();
    let mut oracle = Oracle(Some(
        Command::new("node")
            .args([
                "--import",
                "tsx",
                "scripts/server-rust/settings-semantics-oracle.mjs",
            ])
            .current_dir(root)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?,
    ));
    let stdout = oracle
        .0
        .as_mut()
        .unwrap()
        .stdout
        .take()
        .context("oracle stdout")?;
    let mut count = 0;
    let mut mismatch_count = 0;
    let mut mismatches = Vec::new();
    let mut mismatch_operations = std::collections::BTreeMap::new();
    let mut receipt = None;
    for line in BufReader::new(stdout).lines() {
        let case: Value = serde_json::from_str(&line?)?;
        if let Some(done) = case.get("done") {
            anyhow::ensure!(receipt.is_none(), "duplicate completion");
            receipt = done.as_u64();
            continue;
        }
        anyhow::ensure!(receipt.is_none(), "case after completion");
        let actual = run(&case)?;
        if actual != case["expected"] {
            mismatch_count += 1;
            let op = case["op"].as_str().unwrap().to_owned();
            let op_count = mismatch_operations.entry(op).or_insert(0);
            *op_count += 1;
            if *op_count <= 3 {
                mismatches.push(format!(
                    "Settings semantic case {} {}: actual {} expected {}; input {}",
                    case["id"],
                    case["op"],
                    actual.stringify(),
                    case["expected"].stringify(),
                    case["input"]
                        .stringify()
                        .chars()
                        .take(1800)
                        .collect::<String>(),
                ));
            }
        }
        count += 1;
    }
    let status = oracle.0.as_mut().unwrap().wait()?;
    oracle.0 = None;
    anyhow::ensure!(
        status.success() && count > 0 && receipt == Some(count),
        "incomplete settings oracle {status} {count} {receipt:?}"
    );
    anyhow::ensure!(
        mismatch_count == 0,
        "{mismatch_count} mismatches {mismatch_operations:?} in {count} actual comparisons; locale {:?}:\n{}",
        sys_locale::get_locale(),
        mismatches.join("\n")
    );
    println!(
        "{count} actual Node settings analytics, catalog, URL and metadata hash scenarios matched"
    );
    Ok(())
}
