mod parse;
use super::{Client, api, common::*};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
const SEARCH: &str = include_str!("search.graphql");
const FIELDS: &str = include_str!("activity-fields.graphql");
struct Notice {
    number: f64,
    reason: JsString,
    unread: bool,
}
fn cutoff() -> String {
    (chrono::Utc::now() - chrono::Duration::days(30))
        .format("%Y-%m-%d")
        .to_string()
}
fn notice(value: &Value, kind: &str) -> Result<Option<Notice>> {
    let subject = api::member(value, "subject")?;
    let Some(subject) = subject.filter(|subject| subject.is_object() || subject.is_array()) else {
        return Ok(None);
    };
    if subject["type"]
        != if kind == "pull-request" {
            "PullRequest"
        } else {
            "Issue"
        }
    {
        return Ok(None);
    }
    let Some(url) = subject["url"].as_js_string() else {
        return Ok(None);
    };
    let url = url.lossy();
    let number = ["/issues/", "/pulls/"].into_iter().find_map(|prefix| {
        url.rsplit_once(prefix)
            .map(|(_, number)| number)
            .filter(|number| !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit()))
            .and_then(|number| number.parse::<f64>().ok())
    });
    let Some(number) =
        number.filter(|number| number.is_finite() && *number > 0.0 && number.fract() == 0.0)
    else {
        return Ok(None);
    };
    Ok(Some(Notice {
        number,
        reason: value
            .get("reason")
            .and_then(Value::as_js_string)
            .cloned()
            .unwrap_or_else(|| "unknown".into()),
        unread: value["unread"] == true,
    }))
}
fn query(command: &Value) -> String {
    let kind = if command["kind"] == "pull-request" {
        "is:pr"
    } else {
        "is:issue"
    };
    let mut qualifiers = vec![
        format!("repo:{}", command["repository"].as_str().unwrap()),
        kind.to_owned(),
        format!("is:{}", command["state"].as_str().unwrap()),
    ];
    let extra = match command["view"].as_str().unwrap() {
        "needs-review" => Some("review-requested:@me".to_owned()),
        "failed-checks" => Some("status:failure".into()),
        "approved-ready" => Some("review:approved -is:draft".into()),
        "stale" => Some(format!("updated:<{}", cutoff())),
        "assigned-to-me" => Some("assignee:@me".into()),
        "activity" => Some("mentions:@me".into()),
        _ => None,
    };
    if let Some(extra) = extra {
        qualifiers.push(extra);
    }
    qualifiers.join(" ")
}
impl Client {
    pub(super) async fn inbox(&self, command: &Value, scope: &Scope) -> Result<Value> {
        let repository = api::repository_path(command["repository"].as_js_string().unwrap())?;
        let auth = self.auth_status(scope).await?;
        if auth["authenticated"] != true || !cantrip_wire::coercion::truthy(Some(&auth["login"])) {
            bail!("GitHub authentication is unavailable on this worker.");
        }
        let notification_state = async {
            let values = self
                .api(
                    &format!("{repository}/notifications"),
                    &[
                        "--method".into(),
                        "GET".into(),
                        "-f".into(),
                        "all=true".into(),
                        "-f".into(),
                        "participating=false".into(),
                        "-f".into(),
                        "per_page=50".into(),
                    ],
                    scope,
                )
                .await?;
            let mut notices = Vec::new();
            for value in array(&values) {
                if let Some(value) = notice(value, command["kind"].as_str().unwrap())? {
                    notices.push(value);
                }
            }
            Ok::<_, anyhow::Error>(notices)
        }
        .await;
        let available = notification_state.is_ok();
        let notices = notification_state.unwrap_or_default();
        let (nodes, mut total, next) = if command["view"] == "activity" && available {
            let mut numbers = Vec::new();
            for notice in &notices {
                if (notice.unread
                    || notice.reason.lossy() == "mention"
                    || notice.reason.lossy() == "team_mention")
                    && !numbers.contains(&notice.number)
                {
                    numbers.push(notice.number);
                }
            }
            numbers.truncate(50);
            let mut nodes = Vec::new();
            if !numbers.is_empty() {
                let selections = numbers
                    .iter()
                    .enumerate()
                    .map(|(index, number)| {
                        Ok(format!(
                            "item{index}: issueOrPullRequest(number: {}) {{ {FIELDS} }}",
                            api::text(Some(&Value::Number(*number)))?.lossy()
                        ))
                    })
                    .collect::<Result<Vec<_>>>()?
                    .join("\n");
                let document = format!(
                    "\n    query CantripInboxActivity($owner: String!, $name: String!) {{\n      repository(owner: $owner, name: $name) {{ {selections} }}\n    }}\n  "
                );
                let (owner, name) = command["repository"]
                    .as_str()
                    .unwrap()
                    .split_once('/')
                    .unwrap();
                let value = self
                    .api(
                        "graphql",
                        &[
                            "-f".into(),
                            api::prefix("query=", &document.into()),
                            "-F".into(),
                            format!("owner={owner}").into(),
                            "-F".into(),
                            format!("name={name}").into(),
                        ],
                        scope,
                    )
                    .await?;
                api::member(&value, "data")?;
                let result = &value["data"]["repository"];
                if !result.is_object() && !result.is_array() {
                    bail!("GitHub returned an invalid activity result.");
                }
                for index in 0..numbers.len() {
                    if let Some(node) = result
                        .get(&format!("item{index}"))
                        .filter(|node| node.is_object() || node.is_array())
                    {
                        nodes.push(node.clone());
                    }
                }
            }
            let total = json!(nodes.len());
            (nodes, total, Value::Null)
        } else {
            let mut args = vec![
                "-f".into(),
                api::prefix("query=", &SEARCH.into()),
                "-F".into(),
                format!("searchQuery={}", query(command)).into(),
                "-F".into(),
                api::prefix("first=", &api::text(Some(&command["limit"]))?),
            ];
            if !command["cursor"].is_null() {
                args.extend([
                    "-F".into(),
                    api::prefix("after=", command["cursor"].as_js_string().unwrap()),
                ]);
            }
            let value = self.api("graphql", &args, scope).await?;
            api::member(&value, "data")?;
            let result = &value["data"]["search"];
            if !result.is_object() && !result.is_array() {
                bail!("GitHub returned an invalid inbox search result.");
            }
            let nodes = parse::nodes(result)
                .iter()
                .filter(|node| node.is_object() || node.is_array())
                .cloned()
                .collect::<Vec<_>>();
            let total = if result.get("issueCount").is_some() {
                fallback_number(result, "issueCount", 0.0)?
            } else {
                json!(0)
            };
            let page = &result["pageInfo"];
            let next = if page["hasNextPage"] == true {
                nullable(page.get("endCursor"))
            } else {
                Value::Null
            };
            (nodes, total, next)
        };
        let mut items = Vec::new();
        for node in &nodes {
            let number = api::number(node, "number")?.as_f64().unwrap();
            let notice = notices.iter().rev().find(|notice| notice.number == number);
            if let Some(item) = parse::item(node, &auth["login"], notice)?
                && item["kind"] == command["kind"]
                && item["state"] == command["state"]
            {
                items.push(item);
            }
        }
        if command["view"] == "merge-conflicts" || command["view"] == "approved-ready" {
            let flag = if command["view"] == "merge-conflicts" {
                "merge-conflict"
            } else {
                "approved-ready"
            };
            items.retain(|item| array(&item["attention"]).iter().any(|item| *item == flag));
            total = Value::Null;
        } else if command["view"] == "activity" && !available {
            for item in &mut items {
                if !array(&item["attention"])
                    .iter()
                    .any(|value| *value == "mention")
                {
                    let mut attention = array(&item["attention"]).to_vec();
                    attention.push(json!("mention"));
                    item["attention"] = json!(attention);
                }
            }
        }
        checked(
            "githubInboxListSchema",
            &object([
                ("kind", command["kind"].clone()),
                ("state", command["state"].clone()),
                ("view", command["view"].clone()),
                ("total", total),
                ("items", json!(items)),
                ("nextCursor", next),
                ("viewerLogin", auth["login"].clone()),
                ("activityAvailable", json!(available)),
            ]),
        )
    }
}
