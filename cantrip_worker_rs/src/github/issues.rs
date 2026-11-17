use super::{
    Client,
    api::{member, number, repository_path, string},
};
use crate::filesystem::Scope;
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{Value, coercion, value::json};

pub(super) fn login(value: Option<&Value>) -> Value {
    value
        .and_then(|value| value.get("login"))
        .filter(|value| value.is_string())
        .cloned()
        .unwrap_or_else(|| json!("ghost"))
}
fn count(value: Value) -> Value {
    if coercion::truthy(Some(&value)) {
        value
    } else {
        json!(0)
    }
}
pub(super) fn count_field(value: &Value, field: &str) -> Result<Value> {
    Ok(count(number(value, field)?))
}
pub(super) fn nullable_string(value: Option<&Value>) -> Value {
    value
        .filter(|value| value.is_string())
        .cloned()
        .unwrap_or(Value::Null)
}
pub(super) fn labels(values: &[Value], graphql: bool) -> Result<Value> {
    let mut result = Vec::new();
    for value in values {
        if !graphql && !value.is_object() && !value.is_array() {
            continue;
        }
        let name = member(value, "name")?;
        let color = value.get("color");
        if let (Some(name), Some(color)) = (
            name.filter(|v| v.is_string()),
            color.filter(|v| v.is_string()),
        ) {
            result.push(json!({"name":name,"color":color}));
        }
    }
    Ok(json!(result))
}
pub(super) fn parse_issue(value: &Value) -> Result<Value> {
    let empty = Vec::new();
    let label_values = member(value, "labels")?
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let parsed_labels = labels(label_values, false)?;
    let number = number(value, "number")?;
    let assignees = value["assignees"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .map(|value| login(Some(value)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(
        json!({"number":number,"title":string(value,"title")?,"state":if value["state"]=="closed" {"closed"}else{"open"},
        "url":string(value,"html_url")?,"author":login(value.get("user")),"commentCount":count_field(value,"comments")?,
        "labels":parsed_labels,"assignees":assignees,
        "milestone":nullable_string(value.get("milestone").filter(|v|v.is_object()||v.is_array()).and_then(|v|v.get("title"))),
        "createdAt":string(value,"created_at")?,"updatedAt":string(value,"updated_at")?,"closedAt":nullable_string(value.get("closed_at"))}),
    )
}
fn parse_comment(value: &Value) -> Result<Value> {
    Ok(
        json!({"id":string(value,"id")?,"author":login(value.get("user")),"body":value.get("body").filter(|v|v.is_string()).cloned().unwrap_or_else(||json!("")),
        "url":string(value,"html_url")?,"createdAt":string(value,"created_at")?,"updatedAt":string(value,"updated_at")?}),
    )
}
impl Client {
    pub(super) async fn get_issue(
        &self,
        repository: &cantrip_wire::JsString,
        number: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        let path = format!(
            "{}/issues/{}",
            repository_path(repository)?,
            super::api::text(Some(number))?.lossy()
        );
        let comments_path = format!("{path}/comments");
        let comments_args = vec![
            "--method".into(),
            "GET".into(),
            "--paginate".into(),
            "--slurp".into(),
            "-f".into(),
            "per_page=100".into(),
        ];
        let (raw, comments) = self
            .read_pair(path, comments_path, comments_args, scope.clone())
            .await?;
        let mut result = parse_issue(&raw)?;
        let comments = super::api::pages(&comments, "commentPages")?
            .into_iter()
            .map(parse_comment)
            .collect::<Result<Vec<_>>>()?;
        result["body"] = nullable_string(raw.get("body"));
        result["comments"] = json!(comments);
        checked("githubIssueDetailSchema", &result)
    }
    pub(super) async fn create_issue(&self, command: &Value, scope: &Scope) -> Result<Value> {
        let request = checked("githubIssueCreateSchema", &command["request"])?;
        let path = format!(
            "{}/issues",
            repository_path(command["repository"].as_js_string().unwrap())?
        );
        let raw = self
            .api(
                &path,
                &[
                    "--method".into(),
                    "POST".into(),
                    "-f".into(),
                    super::api::prefix("title=", request["title"].as_js_string().unwrap()),
                    "-f".into(),
                    super::api::prefix("body=", request["body"].as_js_string().unwrap()),
                ],
                scope,
            )
            .await?;
        let mut result = parse_issue(&raw)?;
        result["body"] = nullable_string(raw.get("body"));
        result["comments"] = json!(Vec::<Value>::new());
        checked("githubIssueDetailSchema", &result)
    }
    pub(super) async fn mutate_issue(&self, command: &Value, scope: &Scope) -> Result<Value> {
        let repository = command["repository"].as_js_string().unwrap();
        let path = format!(
            "{}/issues/{}",
            repository_path(repository)?,
            super::api::text(Some(&command["number"]))?.lossy()
        );
        let close = command["type"] == "github.issue.close";
        let comment = if close {
            &command["comment"]
        } else {
            &command["body"]
        };
        if coercion::truthy(Some(comment)) {
            self.api(
                &format!("{path}/comments"),
                &[
                    "--method".into(),
                    "POST".into(),
                    "-f".into(),
                    super::api::prefix("body=", comment.as_js_string().unwrap()),
                ],
                scope,
            )
            .await?;
        }
        if close {
            self.api(
                &path,
                &[
                    "--method".into(),
                    "PATCH".into(),
                    "-f".into(),
                    "state=closed".into(),
                ],
                scope,
            )
            .await?;
        }
        self.get_issue(repository, &command["number"], scope).await
    }
}
