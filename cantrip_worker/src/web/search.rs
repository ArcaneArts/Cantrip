use super::{Operation, Scope, Service, compact_chars, normalize, opaque, scope};
use anyhow::{Context, Result};
use cantrip_protocol::{
    date_iso_milliseconds, date_milliseconds, mcp_host, response::response_error,
};
use cantrip_wire::{JsString, Value, value::json};
use std::{collections::HashSet, time::Duration};
use tokio::time::Instant;
use url::Url;

const MAX_REFERENCES: usize = 5000;
const TTL: Duration = Duration::from_secs(900);

pub(super) struct Reference {
    scope: Scope,
    pub(super) expires: Instant,
    url: Url,
}

impl Service {
    pub(crate) fn has_search(&self) -> bool {
        self.search.is_some()
    }

    pub(crate) async fn search(&self, binding: &Value, args: Option<&Value>) -> Result<Value> {
        let runtime = self
            .search
            .as_ref()
            .context("Web search is unavailable on this worker.")?;
        let args = mcp_host::parse("mcpStdioInput/web_search", args).map_err(response_error)?;
        let scope = scope(binding)?;
        self.consume(&scope, Operation::Search)?;
        let parameters = parameters(&args);
        let payload = runtime.request(&parameters).await?;
        let (result, references) = normalize_results(&args, &payload)?;
        let mut state = self.state.lock().unwrap();
        let expires = Instant::now() + TTL;
        for (id, url) in references {
            state.references.insert(
                id,
                Reference {
                    scope: scope.clone(),
                    expires,
                    url,
                },
            );
        }
        state
            .references
            .retain(|_, item| item.expires > Instant::now());
        while state.references.len() > MAX_REFERENCES {
            state.references.shift_remove_index(0);
        }
        Ok(result)
    }

    pub(super) fn search_url(&self, scope: &Scope, id: &str) -> Result<Url> {
        self.state
            .lock()
            .unwrap()
            .references
            .get(id)
            .filter(|item| &item.scope == scope && item.expires > Instant::now())
            .map(|item| item.url.clone())
            .context("Search result reference is expired or belongs to another task.")
    }
}

fn parameters(args: &Value) -> Vec<(&'static str, String)> {
    let included = domains(&args["includeDomains"]);
    let excluded = domains(&args["excludeDomains"]);
    let mut query = args["query"].as_js_string().unwrap().lossy().into_owned();
    if !included.is_empty() {
        let clauses = included
            .iter()
            .map(|domain| format!("site:{domain}"))
            .collect::<Vec<_>>();
        query.push_str(&format!(" ({})", clauses.join(" OR ")));
    }
    for domain in excluded {
        query.push_str(&format!(" -site:{domain}"));
    }
    let safe = match args["safeSearch"].as_str() {
        Some("off") => "0",
        Some("strict") => "2",
        _ => "1",
    };
    let mut result = vec![
        ("categories", args["category"].as_str().unwrap().into()),
        ("format", "json".into()),
        (
            "language",
            args["language"].as_str().unwrap_or("auto").into(),
        ),
        ("pageno", args["page"].as_u64().unwrap().to_string()),
        ("q", query),
        ("safesearch", safe.into()),
        ("timeout_limit", "8".into()),
    ];
    if let Some(freshness) = args["freshness"].as_str() {
        result.push(("time_range", freshness.into()));
    }
    result
}

fn domains(values: &Value) -> Vec<&str> {
    values
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap())
        .collect()
}

fn matches_domain(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn compact(value: &Value, limit: usize) -> JsString {
    let units = value.as_js_string().map_or(&[][..], JsString::units);
    compact_chars(
        char::decode_utf16(units.iter().copied())
            .map(|result| result.map_err(|error| error.unpaired_surrogate())),
        limit,
    )
}

fn normalize_results(args: &Value, payload: &Value) -> Result<(Value, Vec<(String, Url)>)> {
    let included = domains(&args["includeDomains"]);
    let excluded = domains(&args["excludeDomains"]);
    let mut seen = HashSet::new();
    let mut results = Vec::new();
    let mut references = Vec::new();
    let source = payload["results"]
        .as_array()
        .map_or(&[][..], |values| values);
    let limit = args["count"].as_u64().unwrap() as usize;
    for row in source {
        if results.len() >= limit {
            break;
        }
        let Some(url) = row["url"]
            .as_js_string()
            .and_then(|raw| Url::parse(&raw.lossy()).ok())
            .and_then(|url| normalize(url).ok())
        else {
            continue;
        };
        let host = url.host_str().unwrap();
        if (!included.is_empty() && !included.iter().any(|domain| matches_domain(host, domain)))
            || excluded.iter().any(|domain| matches_domain(host, domain))
            || !seen.insert(url.clone())
        {
            continue;
        }
        let id = opaque("wsr")?;
        let engines: Vec<_> = row["engines"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_js_string)
            .take(10)
            .collect();
        let published = row["publishedDate"]
            .as_js_string()
            .and_then(date_milliseconds)
            .and_then(date_iso_milliseconds);
        results.push(json!({
            "id":id,"title":compact(&row["title"], 1_000),"url":url.as_str(),
            "snippet":compact(&row["content"], 4_000),"engines":engines,"publishedAt":published,
        }));
        references.push((id, url));
    }
    let diagnostics: Vec<Value> = payload["unresponsive_engines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(diagnostic)
        .take(10)
        .collect();
    let result_count = results.len();
    let failures = diagnostics.len();
    let plural = if result_count == 1 { "" } else { "s" };
    let more = if failures == 0 {
        String::new()
    } else {
        let plural = if failures == 1 { "" } else { "s" };
        format!(" with {failures} partial engine failure{plural}")
    };
    let query = compact(&payload["query"], 500);
    let query = if query.is_empty() {
        args["query"].clone()
    } else {
        json!(query)
    };
    let result = json!({
        "summary":format!("Search returned {result_count} result{plural}{more}."),
        "target":Value::Null,"worktreeId":Value::Null,"continuationScheduled":false,"mutated":false,
        "data":json!({"query":query,"results":results,"diagnostics":diagnostics,"truncated":source.len() > result_count}),
    });
    Ok((
        mcp_host::parse("mcpStdioOutput/web_search", Some(&result)).map_err(response_error)?,
        references,
    ))
}

fn diagnostic(item: &Value) -> Option<Value> {
    let fields = item.as_array()?;
    let engine = fields.first()?.as_js_string()?;
    let engine = JsString::new(engine.units().iter().copied().take(100).collect());
    let reason = compact(fields.get(1).unwrap_or(&Value::Null), 200)
        .lossy()
        .to_lowercase();
    let category = if reason.contains("captcha") {
        "captcha"
    } else if reason.contains("rate") || reason.contains("429") {
        "rate-limited"
    } else if reason.contains("timeout") {
        "timeout"
    } else if reason.contains("network") || reason.contains("connect") {
        "unavailable"
    } else {
        "unknown"
    };
    let mut message = "The ".encode_utf16().collect::<Vec<_>>();
    message.extend_from_slice(engine.units());
    message.extend(format!(" engine was {}.", category.replace('-', " ")).encode_utf16());
    Some(json!({"engine":engine,"category":category,"message":JsString::new(message)}))
}
