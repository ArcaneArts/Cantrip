//! Host skill inventory and documents returned as protected customization content.
mod files;

use super::{
    library::{self, Location, Root, Skill},
    list,
};
use crate::{
    codex::preparation::command::Ensurer, encryption::Service, filesystem::paths,
    protected_content::customization::Operation, protected_secrets::open_runtime_provider,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use icu_collator::{Collator, CollatorBorrowed, options::CollatorOptions};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const CHAT_LIST: &str = "skills.list";
const SETTINGS_LIST: &str = "skills.settings.list";
const SETTINGS_READ: &str = "skills.settings.read";
const RPC_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) fn supports(kind: &str) -> bool {
    matches!(kind, CHAT_LIST | SETTINGS_LIST | SETTINGS_READ)
}

#[derive(Clone)]
pub(crate) struct Settings {
    preparation: Ensurer,
    encryption: Arc<Service>,
    data: PathBuf,
    global: Option<PathBuf>,
}

impl Settings {
    pub(crate) fn new(
        preparation: Ensurer,
        encryption: Arc<Service>,
        data: PathBuf,
        global: Option<PathBuf>,
    ) -> Self {
        Self {
            preparation,
            encryption,
            data,
            global,
        }
    }

    pub(crate) async fn execute(&self, incoming: &Value) -> Result<Value> {
        let operation = Operation::new(&self.encryption, incoming)?;
        let kind = incoming["type"]
            .as_str()
            .context("Missing skill operation.")?;
        let provider = if kind == CHAT_LIST {
            &incoming["provider"]["id"]
        } else {
            &incoming["providerId"]
        };
        ensure!(
            operation.scope["providerId"] == *provider && !provider.is_null(),
            "The skill settings provider changed."
        );
        let schema = match kind {
            CHAT_LIST => "skillListSchema",
            SETTINGS_LIST => "skillSettingsInventorySchema",
            SETTINGS_READ => "skillSettingsDocumentSchema",
            _ => unreachable!("Validated skill dispatch"),
        };
        let input = if kind == SETTINGS_READ {
            operation.open(
                &incoming["protectedRequest"],
                "skillSettingsReadContentSchema",
            )?
        } else {
            Value::Null
        };
        let result = self.run(incoming, &operation, kind, &input).await;
        operation.seal(result, schema)
    }

    async fn run(
        &self,
        incoming: &Value,
        operation: &Operation<'_>,
        kind: &str,
        input: &Value,
    ) -> Result<Value> {
        let resolved = self
            .preparation
            .resolve_routing(&json!({"cwd":incoming["cwd"]}))
            .await?;
        let cwd = resolved["cwd"].as_js_string();
        if kind == CHAT_LIST {
            let cwd = cwd.context("Missing skill workspace.")?;
            let (skills, _) = self.runtime_skills(incoming, operation, cwd, false).await?;
            return chat_summary(skills);
        }
        let provider = incoming["providerId"]
            .as_js_string()
            .context("Missing skill provider ID.")?;
        let provider_kind = incoming["providerKind"]
            .as_str()
            .context("Missing skill provider kind.")?;
        let roots = library::roots(&self.data, self.global.as_deref(), provider, provider_kind);
        let cwd_path = cwd.map(paths::native);
        if kind == SETTINGS_READ {
            let input = input.clone();
            return tokio::task::spawn_blocking(move || {
                files::read(settings_roots(roots, cwd_path.as_deref())?, &input)
            })
            .await?;
        }
        let (native, errors) = if incoming["model"].is_null() || incoming["provider"].is_null() {
            (Vec::new(), Vec::new())
        } else {
            let fallback = paths::text(&self.data);
            self.runtime_skills(incoming, operation, cwd.unwrap_or(&fallback), true)
                .await?
        };
        tokio::task::spawn_blocking(move || {
            inventory(settings_roots(roots, cwd_path.as_deref())?, native, errors)
        })
        .await?
    }

    async fn runtime_skills(
        &self,
        command: &Value,
        operation: &Operation<'_>,
        cwd: &JsString,
        force_reload: bool,
    ) -> Result<(Vec<Value>, Vec<Value>)> {
        let provider = open_runtime_provider(&self.encryption, &command["provider"])?;
        ensure!(
            provider["id"] == operation.scope["providerId"],
            "The skill runtime provider changed."
        );
        let runtime = self
            .preparation
            .helper_runtime(
                &command["model"],
                provider,
                operation.identity(),
                operation.scope["chatId"].as_js_string(),
            )
            .await?;
        list(&runtime, cwd, force_reload, RPC_TIMEOUT).await
    }
}

fn settings_roots(mut roots: Vec<Root>, cwd: Option<&Path>) -> Result<Vec<Root>> {
    if let Some(cwd) = cwd {
        roots.insert(
            0,
            Root {
                path: paths::canonical_sync(cwd)?.join(".agents/skills"),
                location: Location::Project,
            },
        );
    }
    Ok(roots)
}

fn sorting() -> Result<CollatorBorrowed<'static>> {
    let locale: icu_locale_core::Locale = cantrip_wire::environment::locale()
        .unwrap_or("en-US")
        .parse()
        .unwrap_or_else(|_| "en-US".parse().unwrap());
    Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|e| anyhow::anyhow!("Skill sorting locale: {e}"))
}

fn compare(
    collator: &CollatorBorrowed<'_>,
    left: &Value,
    right: &Value,
    field: &str,
) -> std::cmp::Ordering {
    fn text<'a>(value: &'a Value, field: &str) -> &'a JsString {
        value["displayName"]
            .as_js_string()
            .or_else(|| value[field].as_js_string())
            .expect("Parsed skill name or path")
    }
    collator.compare_utf16_icu4c(text(left, field).units(), text(right, field).units())
}

fn chat_summary(skills: Vec<Value>) -> Result<Value> {
    let mut names = HashSet::new();
    let mut summary = skills
        .into_iter()
        .filter_map(|skill| {
            let name = skill["name"].as_js_string()?.trim();
            if skill["enabled"] == false || name.is_empty() || !names.insert(name.clone()) {
                return None;
            }
            Some(
                json!({"name":name, "description":skill["description"].as_str().unwrap_or_default(),
            "displayName":skill["interface"]["displayName"].as_js_string()}),
            )
        })
        .collect::<Vec<_>>();
    let collator = sorting()?;
    summary.sort_by(|a, b| compare(&collator, a, b, "name"));
    Ok(json!(summary))
}

fn text_path(path: &Path) -> Result<PathBuf> {
    Ok(library::optional_canonical(path)?.unwrap_or(paths::resolve(path)?))
}

fn inventory(roots: Vec<Root>, native: Vec<Value>, errors: Vec<Value>) -> Result<Value> {
    let mut enabled = HashMap::new();
    for skill in native {
        if let Some(path) = skill["path"].as_js_string().filter(|path| !path.is_empty())
            && skill["name"]
                .as_js_string()
                .is_some_and(|name| !name.trim().is_empty())
            && matches!(
                skill["scope"].as_str(),
                Some("user" | "repo" | "system" | "admin")
            )
        {
            enabled.insert(text_path(&paths::native(path))?, skill["enabled"] != false);
        }
    }
    let mut project = Vec::new();
    let mut global = Vec::new();
    let mut issues = Vec::new();
    let collator = sorting()?;
    for root in roots {
        let entries = root.scan().and_then(|skills| {
            skills
                .into_iter()
                .map(|skill| {
                    let document = skill.canonical.join("SKILL.md");
                    item(
                        &root,
                        &skill,
                        enabled.get(&document).copied().unwrap_or(true),
                    )
                })
                .collect::<Result<Vec<_>>>()
        });
        match entries {
            Ok(mut entries) => {
                entries.sort_by(|a, b| compare(&collator, a, b, "name"));
                if root.location == Location::Project {
                    project.extend(entries);
                } else {
                    global.extend(entries);
                }
            }
            Err(cause) => {
                issues.push(json!({"path":paths::text(&root.path),"message":cause.to_string()}))
            }
        }
    }
    issues.extend(errors.into_iter().filter_map(|error| {
        let message = error["message"]
            .as_js_string()
            .filter(|message| !message.is_empty())?;
        Some(json!({"path":error["path"].as_str().unwrap_or(""),"message":message}))
    }));
    Ok(json!({"project":project,"global":global,"errors":issues}))
}

fn item(root: &Root, skill: &Skill, enabled: bool) -> Result<Value> {
    let content = files::read_text(&skill.canonical.join("SKILL.md"))?;
    let (name, description) = files::frontmatter(&content);
    let name = name.unwrap_or_else(|| {
        skill
            .directory
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    Ok(json!({
        "name":name,"description":description.as_deref().unwrap_or("No description provided."),
        "displayName":files::display_name(&skill.canonical),"id":root.skill_id(skill),
        "audienceKey":root.audience_key(skill)?,"audience":"ide", "scope":root.location.scope(),
        "location":root.location.name(),"path":paths::text(&skill.directory.join("SKILL.md")),
        "enabled":enabled,"editable":skill.editable,"deletable":skill.editable,
    }))
}
