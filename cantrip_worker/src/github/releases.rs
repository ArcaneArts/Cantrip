use super::{Client, api, common::*};
use crate::filesystem::Scope;
use anyhow::{Result, anyhow};
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};
fn parse(value: &Value) -> Result<Value> {
    let tag = api::string(value, "tag_name")?;
    let name = value
        .get("name")
        .filter(|name| name.as_js_string().is_some_and(|s| !s.trim().is_empty()))
        .cloned()
        .unwrap_or_else(|| tag.clone());
    checked(
        "githubReleaseSummarySchema",
        &object([
            ("id", api::number(value, "id")?),
            ("tagName", tag),
            ("name", name),
            (
                "body",
                value
                    .get("body")
                    .filter(|v| v.is_string())
                    .cloned()
                    .unwrap_or_else(|| json!("")),
            ),
            ("url", api::string(value, "html_url")?),
            ("author", super::issues::login(value.get("author"))),
            ("draft", json!(value["draft"] == true)),
            ("prerelease", json!(value["prerelease"] == true)),
            ("createdAt", api::string(value, "created_at")?),
            ("publishedAt", nullable(value.get("published_at"))),
        ]),
    )
}
impl Client {
    pub(super) async fn releases(&self, command: &Value, scope: &Scope) -> Result<Value> {
        let repository = api::repository_path(command["repository"].as_js_string().unwrap())?;
        match command["type"].as_str().unwrap() {
            "github.releases.list" => {
                let values = self
                    .api(
                        &format!("{repository}/releases"),
                        &[
                            "--method".into(),
                            "GET".into(),
                            "-f".into(),
                            "per_page=100".into(),
                            "-f".into(),
                            "page=1".into(),
                        ],
                        scope,
                    )
                    .await?;
                let values = values.as_array().ok_or_else(|| {
                    if values.is_null() {
                        anyhow!("Cannot read properties of null (reading 'map')")
                    } else {
                        anyhow!("values.map is not a function")
                    }
                })?;
                checked(
                    "githubReleaseListSchema",
                    &json!({"releases":values.iter().map(parse).collect::<Result<Vec<_>>>()?,"truncated":values.len()>=100}),
                )
            }
            "github.release.get" => parse(
                &self
                    .api(
                        &format!(
                            "{repository}/releases/{}",
                            api::text(Some(&command["releaseId"]))?.lossy()
                        ),
                        &[],
                        scope,
                    )
                    .await?,
            ),
            _ => {
                let request = &command["request"];
                let tag = join(
                    &[
                        "refs/tags/".into(),
                        request["tagName"].as_js_string().unwrap().clone(),
                        "^{commit}".into(),
                    ],
                    "",
                );
                let target = match git(
                    command,
                    &["rev-parse".into(), "--verify".into(), tag],
                    scope,
                )
                .await
                {
                    Ok(value) => value,
                    Err(_) => {
                        git(
                            command,
                            &[
                                "rev-parse".into(),
                                "--verify".into(),
                                "HEAD^{commit}".into(),
                            ],
                            scope,
                        )
                        .await?
                    }
                }
                .trim();
                let mut args = vec!["--method".into(), "POST".into()];
                for (name, value, flag) in [
                    ("tag_name", request["tagName"].clone(), "-f"),
                    ("target_commitish", Value::String(target), "-f"),
                    ("name", request["name"].clone(), "-f"),
                    ("body", request["body"].clone(), "-f"),
                    ("draft", request["draft"].clone(), "-F"),
                    ("prerelease", request["prerelease"].clone(), "-F"),
                ] {
                    args.extend([
                        flag.into(),
                        api::prefix(&format!("{name}="), &api::text(Some(&value))?),
                    ]);
                }
                parse(
                    &self
                        .api(&format!("{repository}/releases"), &args, scope)
                        .await?,
                )
            }
        }
    }
}
