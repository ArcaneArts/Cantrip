use super::{Client, process};
use crate::filesystem::Scope;
use anyhow::{Result, anyhow, bail};
use cantrip_crypto::checked;
use cantrip_wire::{Value, coercion, parse_json_text, value::json};
use icu_collator::{Collator, options::CollatorOptions};

const MIB: usize = 1024 * 1024;
const UNAUTHENTICATED: &str =
    "GitHub is not authenticated on this worker. Run `gh auth login` or set GH_TOKEN.";
fn parse(raw: &str) -> Result<Value> {
    parse_json_text(raw).map_err(|e| crate::error::WireError(e).into())
}
// JavaScript Array.flat() removes exactly one level here, not arbitrary nesting.
fn pages(value: &Value) -> Result<Vec<&Value>> {
    let values = value.as_array().ok_or_else(|| {
        if value.is_null() {
            anyhow!("Cannot read properties of null (reading 'flat')")
        } else {
            anyhow!("pages.flat is not a function")
        }
    })?;
    Ok(values
        .iter()
        .flat_map(|value| {
            value
                .as_array()
                .map_or_else(|| vec![value], |values| values.iter().collect())
        })
        .collect())
}
fn string(value: &Value, field: &str) -> Result<Value> {
    if value.is_null() {
        bail!("Cannot read properties of null (reading '{field}')");
    }
    Ok(Value::String(match value.get(field) {
        Some(value) => coercion::string(value)
            .map_err(|_| anyhow!("Cannot convert object to primitive value"))?,
        None => "undefined".into(),
    }))
}
fn repository(value: &Value) -> Result<Value> {
    Ok(json!({
        "id":string(value,"id")?,"name":string(value,"name")?,
        "nameWithOwner":string(value,"full_name")?,
        "description":value.get("description").filter(|v|v.as_js_string().is_some()).cloned().unwrap_or(Value::Null),
        "isPrivate":value["private"]==true,"isFork":value["fork"]==true,
        "url":string(value,"html_url")?,"defaultBranch":string(value,"default_branch")?,
        "updatedAt":string(value,"updated_at")?
    }))
}
fn collator() -> Result<icu_collator::CollatorBorrowed<'static>> {
    let locale: icu_locale_core::Locale = cantrip_wire::environment::locale()
        .unwrap_or("en-US")
        .parse()
        .unwrap_or_else(|_| "en-US".parse().unwrap());
    Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|e| anyhow!("GitHub sorting locale: {e}"))
}
impl Client {
    fn cache_path(&self) -> std::path::PathBuf {
        self.directory.join("github").join("repositories.json")
    }
    pub(super) async fn auth_status(&self, scope: &Scope) -> Result<Value> {
        let status = async {
            let login = process::run(&["api","user","--jq",".login"], MIB, scope).await?;
            let login = cantrip_wire::JsString::from(login).trim();
            let token = ["GH_TOKEN","GITHUB_TOKEN"].iter().any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()));
            checked("githubAuthStatusSchema", &json!({"authenticated":true,"login":login,"source":if token {"token"}else{"gh-cli"}}))
        }.await;
        Ok(status
            .unwrap_or_else(|_| json!({"authenticated":false,"login":Value::Null,"source":"none"})))
    }
    async fn login(&self, scope: &Scope) -> Result<Value> {
        let status = self.auth_status(scope).await?;
        if status["authenticated"] != true {
            bail!(UNAUTHENTICATED);
        }
        Ok(status["login"].clone())
    }
    pub(super) async fn cached(&self, login: &Value) -> Value {
        let read = async {
            let bytes = tokio::fs::read(self.cache_path()).await?;
            let cache = parse(&String::from_utf8_lossy(&bytes))?;
            if cache["login"] != *login {
                return Ok(json!(Vec::<Value>::new()));
            }
            checked("githubWorkerRepositoryListSchema", &cache["repositories"])
        }
        .await;
        read.unwrap_or_else(|_: anyhow::Error| json!(Vec::<Value>::new()))
    }
    pub(super) async fn repositories(&self, scope: &Scope) -> Result<Value> {
        let login = self.login(scope).await?;
        let raw = process::run(
            &[
                "api",
                "--method",
                "GET",
                "--paginate",
                "--slurp",
                "user/repos",
                "-f",
                "per_page=100",
                "-f",
                "affiliation=owner,collaborator,organization_member",
                "-f",
                "sort=updated",
            ],
            32 * MIB,
            scope,
        )
        .await?;
        let value = parse(&raw)?;
        let mut repositories = pages(&value)?
            .into_iter()
            .map(repository)
            .collect::<Result<Vec<_>>>()?;
        let collator = collator()?;
        repositories.sort_by(|left, right| {
            collator.compare_utf16_icu4c(
                right["updatedAt"].as_js_string().unwrap().units(),
                left["updatedAt"].as_js_string().unwrap().units(),
            )
        });
        let repositories = checked("githubWorkerRepositoryListSchema", &json!(repositories))?;
        self.publish_cache(&login, &repositories).await;
        Ok(repositories)
    }
    async fn publish_cache(&self, login: &Value, repositories: &Value) {
        let path = self.cache_path();
        // Exclusive, uniquely owned staging avoids concurrent refreshes sharing a
        // temporary file. A cache failure must never fail the successful query.
        let temporary = path.with_file_name(format!(
            "repositories.json.{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let pending = temporary.clone();
        let directory = path.parent().unwrap().to_owned();
        let bytes = json!({"login":login,"repositories":repositories,"updatedAt":cantrip_wire::date::iso_milliseconds(chrono::Utc::now().timestamp_millis()).unwrap()}).stringify().into_bytes();
        let written = tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            cantrip_host::files::private_directory(&directory)?;
            cantrip_host::files::write_private(&pending, &bytes)
        })
        .await;
        if !matches!(written, Ok(Ok(()))) || tokio::fs::rename(&temporary, &path).await.is_err() {
            let _ = tokio::fs::remove_file(temporary).await;
        }
    }
    pub(super) async fn owners(&self, scope: &Scope) -> Result<Value> {
        let login = self.login(scope).await?;
        let raw = process::run(
            &[
                "api",
                "--method",
                "GET",
                "--paginate",
                "--slurp",
                "user/orgs",
                "-f",
                "per_page=100",
            ],
            8 * MIB,
            scope,
        )
        .await?;
        let value = parse(&raw)?;
        let mut organizations = Vec::new();
        for organization in pages(&value)? {
            if organization.is_null() {
                bail!("Cannot destructure property 'login' of 'object null' as it is null.");
            }
            if let Some(value) = organization
                .get("login")
                .filter(|v| v.as_js_string().is_some() && **v != login)
            {
                organizations.push(value.clone());
            }
        }
        let collator = collator()?;
        organizations.sort_by(|left, right| {
            collator.compare_utf16_icu4c(
                left.as_js_string().unwrap().units(),
                right.as_js_string().unwrap().units(),
            )
        });
        let mut result = vec![json!({"login":login,"kind":"user"})];
        let mut seen = std::collections::HashSet::new();
        for login in organizations {
            if seen.insert(login.as_js_string().unwrap().clone()) {
                result.push(json!({"login":login,"kind":"organization"}));
            }
        }
        checked("githubRepositoryOwnerListSchema", &json!(result))
    }
    pub(super) async fn create(&self, input: &Value, scope: &Scope) -> Result<Value> {
        let request = checked("githubRepositoryCreateSchema", input)?;
        let name = format!(
            "{}/{}",
            request["owner"].as_str().unwrap(),
            request["name"].as_str().unwrap()
        );
        let visibility = format!("--{}", request["visibility"].as_str().unwrap());
        let mut args = vec![
            "repo".into(),
            "create".into(),
            name.clone().into(),
            visibility.into(),
        ];
        if request["initialize"] == "readme" {
            args.push("--add-readme".into());
        }
        let description = request["description"].as_js_string().unwrap();
        if !description.units().is_empty() {
            args.extend(["--description".into(), description.clone()]);
        }
        process::run_values(&args, 8 * MIB, scope).await?;
        let api = format!("repos/{name}");
        let raw = process::run(&["api", &api], 32 * MIB, scope).await?;
        checked("githubWorkerRepositorySchema", &repository(&parse(&raw)?)?)
    }
}
