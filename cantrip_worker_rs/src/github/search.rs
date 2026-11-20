//! Provider-side issue/PR filters, exact GraphQL arguments and bounded
//! mergeability scans. Opaque cursors are forwarded without reinterpretation.
use super::{
    Client,
    api::{member, prefix, repository_path, string, text},
    issues::{count_field, labels, login, nullable_string},
};
use crate::filesystem::Scope;
use anyhow::{Result, anyhow, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, coercion, value::json};
const QUERY: &str = include_str!("list.graphql");
fn quote(value: &JsString) -> JsString {
    let mut result = vec![34];
    for unit in value.units() {
        if [34, 92].contains(unit) {
            result.push(92);
        }
        result.push(*unit);
    }
    result.push(34);
    JsString::new(result)
}
pub fn query(
    repository: &JsString,
    kind: &str,
    state: &str,
    input: &Value,
    now: Option<i64>,
) -> Result<JsString> {
    repository_path(repository)?;
    let filters = checked("githubIssueListFiltersSchema", input)?;
    let pull = kind == "pull-request";
    if !pull
        && (filters["view"] == "review-requested"
            || ["draft", "reviewDecision", "mergeability", "checksState"]
                .iter()
                .any(|key| !filters[*key].is_null()))
    {
        bail!("Pull request filters cannot be applied to issues.");
    }
    let mut terms = vec![
        prefix("repo:", repository),
        JsString::from(if pull { "is:pr" } else { "is:issue" }),
        format!("is:{state}").into(),
    ];
    if coercion::truthy(Some(&filters["search"])) {
        terms.push(quote(filters["search"].as_js_string().unwrap()));
    }
    for label in filters["labels"].as_array().unwrap() {
        terms.push(prefix("label:", &quote(label.as_js_string().unwrap())));
    }
    for field in ["author", "assignee"] {
        if !filters[field].is_null() {
            terms.push(prefix(
                &format!("{field}:"),
                filters[field].as_js_string().unwrap(),
            ));
        }
    }
    if !filters["milestone"].is_null() {
        terms.push(prefix(
            "milestone:",
            &quote(filters["milestone"].as_js_string().unwrap()),
        ));
    }
    match filters["view"].as_str().unwrap() {
        "assigned-to-me" => terms.push("assignee:@me".into()),
        "review-requested" => terms.push("review-requested:@me".into()),
        "recently-updated" => {
            let now = now.unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
            let threshold = now
                .checked_sub(30 * 24 * 60 * 60 * 1000)
                .and_then(cantrip_wire::date::iso_milliseconds)
                .ok_or_else(|| anyhow!("Invalid time value"))?;
            terms.push(format!("updated:>={}", &threshold[..10]).into());
        }
        _ => {}
    }
    if pull {
        if filters["draft"] == true {
            terms.push("is:draft".into());
        }
        if filters["draft"] == false {
            terms.push("-is:draft".into());
        }
        if let Some(decision) = filters["reviewDecision"].as_str() {
            terms.push(
                format!(
                    "review:{}",
                    match decision {
                        "changes-requested" => "changes_requested",
                        "review-required" => "required",
                        other => other,
                    }
                )
                .into(),
            );
        }
        if let Some(state) = filters["checksState"].as_str() {
            terms.push(format!("status:{state}").into());
        }
    }
    terms.push("sort:updated-desc".into());
    let mut result = Vec::new();
    for (index, term) in terms.iter().enumerate() {
        if index != 0 {
            result.push(32);
        }
        result.extend(term.units());
    }
    Ok(JsString::new(result))
}
fn nodes(value: Option<&Value>) -> &[Value] {
    value
        .and_then(|v| v.get("nodes"))
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}
fn issue(value: &Value) -> Result<Value> {
    let number = super::api::number(value, "number")?;
    let assignees = nodes(value.get("assignees"))
        .iter()
        .map(|value| login(Some(value)))
        .collect::<Vec<_>>();
    Ok(
        json!({"number":number,"title":string(value,"title")?,"state":if value["state"]=="OPEN" {"open"}else{"closed"},
        "url":string(value,"url")?,"author":login(value.get("author")),"commentCount":count_field(value.get("comments").filter(|v|!v.is_null()).unwrap_or(&json!({})),"totalCount")?,
        "labels":labels(nodes(value.get("labels")),true)?,"assignees":assignees,
        "milestone":nullable_string(value.get("milestone").and_then(|v|v.get("title"))),
        "createdAt":string(value,"createdAt")?,"updatedAt":string(value,"updatedAt")?,"closedAt":nullable_string(value.get("closedAt"))}),
    )
}
fn pull_request(value: &Value) -> Result<Value> {
    let mut result = issue(value)?;
    result["body"] = nullable_string(value.get("body"));
    result["draft"] = json!(value["isDraft"] == true);
    result["merged"] = json!(value["merged"] == true);
    for (target, source, fallback) in [
        ("headRef", "headRefName", "unknown"),
        ("headSha", "headRefOid", ""),
        ("baseRef", "baseRefName", "unknown"),
        ("baseSha", "baseRefOid", ""),
    ] {
        result[target] = Value::String(text(Some(
            value
                .get(source)
                .filter(|v| !v.is_null())
                .unwrap_or(&json!(fallback)),
        ))?);
    }
    result["mergeable"] = match value["mergeable"].as_str() {
        Some("MERGEABLE") => json!(true),
        Some("CONFLICTING") => json!(false),
        _ => Value::Null,
    };
    result["reviewDecision"] = json!(match value.get("reviewDecision").filter(|v| !v.is_null()) {
        None => "none",
        Some(value) => match value.as_str() {
            Some("APPROVED") => "approved",
            Some("CHANGES_REQUESTED") => "changes-requested",
            Some("REVIEW_REQUIRED") => "review-required",
            _ => "reviewed",
        },
    });
    let state = nodes(value.get("commits"))
        .first()
        .and_then(|v| v.get("commit"))
        .and_then(|v| v.get("statusCheckRollup"))
        .and_then(|v| v.get("state"))
        .filter(|v| !v.is_null());
    result["checksState"] = json!(match state {
        None => "none",
        Some(value) => match value.as_str() {
            Some("SUCCESS") => "success",
            Some("ERROR" | "FAILURE") => "failure",
            Some("EXPECTED" | "PENDING") => "pending",
            _ => "unknown",
        },
    });
    checked("githubPullRequestSummarySchema", &result)
}
impl Client {
    pub(crate) async fn count_open_issues(
        &self,
        repository: &JsString,
        scope: &Scope,
    ) -> Result<f64> {
        repository_path(repository)?;
        let search = format!("q=repo:{} is:issue is:open", repository.lossy());
        let result = self
            .api(
                "search/issues",
                &[
                    "--method".into(),
                    "GET".into(),
                    "-f".into(),
                    search.into(),
                    "-f".into(),
                    "per_page=1".into(),
                ],
                scope,
            )
            .await?;
        result["total_count"]
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 0. && value.fract() == 0.)
            .ok_or_else(|| anyhow!("GitHub returned an invalid open issue count."))
    }

    pub(super) async fn list_issues(&self, command: &Value, scope: &Scope) -> Result<Value> {
        let pull = command["type"] == "github.pull-requests.list";
        let kind = if pull { "pull-request" } else { "issue" };
        let filters = checked("githubIssueListFiltersSchema", &command["filters"])?;
        let search = query(
            command["repository"].as_js_string().unwrap(),
            kind,
            command["state"].as_str().unwrap(),
            &filters,
            None,
        )?;
        let scan = pull && !filters["mergeability"].is_null();
        let limit = command["limit"].as_u64().unwrap() as usize;
        let mut items = Vec::new();
        let mut current = command["cursor"].clone();
        let mut next = Value::Null;
        let mut total = Value::Null;
        for _ in 0..if scan { 10 } else { 1 } {
            if items.len() >= limit {
                break;
            }
            let mut args = vec![
                "-f".into(),
                format!("query={QUERY}").into(),
                "-f".into(),
                prefix("search=", &search),
                "-F".into(),
                format!("first={}", limit - items.len()).into(),
            ];
            if coercion::truthy(Some(&current)) {
                args.extend([
                    "-f".into(),
                    prefix("after=", current.as_js_string().unwrap()),
                ]);
            }
            let response = self.api("graphql", &args, scope).await?;
            let found = member(&response, "data")?.and_then(|v| v.get("search"));
            let Some(found) = found.filter(|v| {
                coercion::truthy(Some(v))
                    && coercion::truthy(v.get("pageInfo"))
                    && v.get("nodes").is_some_and(|v| v.is_array())
            }) else {
                bail!("GitHub returned an invalid issue search response.");
            };
            if !scan {
                let count = coercion::number(found.get("issueCount"))
                    .map_err(|_| anyhow!("Cannot convert object to primitive value"))?;
                total = if count.is_finite() {
                    Value::Number(count)
                } else {
                    Value::Null
                };
            }
            for node in found["nodes"].as_array().unwrap() {
                let typename = member(node, "__typename")?;
                if typename.is_some_and(|v| v == if pull { "PullRequest" } else { "Issue" }) {
                    let item = if pull {
                        pull_request(node)?
                    } else {
                        issue(node)?
                    };
                    let matches = match filters["mergeability"].as_str() {
                        Some("mergeable") => item["mergeable"] == true,
                        Some("conflicting") => item["mergeable"] == false,
                        Some("unknown") => item["mergeable"].is_null(),
                        _ => true,
                    };
                    if matches {
                        items.push(item);
                    }
                }
            }
            let page = &found["pageInfo"];
            let has_next = page["hasNextPage"] == true;
            if has_next && !page["endCursor"].is_string() {
                bail!("GitHub omitted the next issue search cursor.");
            }
            next = if has_next {
                page["endCursor"].clone()
            } else {
                Value::Null
            };
            if !has_next || !scan || items.len() >= limit {
                break;
            }
            current = next.clone();
        }
        if pull {
            checked(
                "githubPullRequestListSchema",
                &json!({"state":command["state"],"total":total,"pullRequests":items,"nextCursor":next}),
            )
        } else {
            checked(
                "githubIssueListSchema",
                &json!({"kind":"issue","state":command["state"],"total":total,"issues":items,"nextCursor":next}),
            )
        }
    }
}
