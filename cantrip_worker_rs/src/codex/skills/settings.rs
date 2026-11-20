//! Host skill settings and Project Chat skill controls.
mod files;
mod mutations;

use super::{
    library::{self, Location, Root, Skill},
    list,
};
use crate::{
    codex::{customizations, managed::Runtime, preparation::command::Ensurer},
    encryption::Service,
    filesystem::paths,
    protected_content::customization::{Operation, Replay},
    protected_secrets::open_runtime_provider,
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
use tokio::sync::RwLock;

const CHAT_LIST: &str = "skills.list";
const CHAT_CONFIGURE: &str = "customization.skill.configure";
const SETTINGS_LIST: &str = "skills.settings.list";
const SETTINGS_READ: &str = "skills.settings.read";
const SETTINGS_WRITE: &str = "skills.settings.write";
const SETTINGS_DELETE: &str = "skills.settings.delete";
const SETTINGS_CONFIGURE: &str = "skills.settings.configure";
const RPC_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) fn supports(kind: &str) -> bool {
    customizations::Command::find(kind).is_some()
        || matches!(
            kind,
            CHAT_LIST
                | CHAT_CONFIGURE
                | SETTINGS_LIST
                | SETTINGS_READ
                | SETTINGS_WRITE
                | SETTINGS_DELETE
                | SETTINGS_CONFIGURE
        )
}

#[derive(Default)]
struct Changes {
    replay: Replay,
    // Account and global roots can be selected by multiple projects. Readers
    // must see a complete generation across a recovery rename or config write.
    access: RwLock<()>,
}

#[derive(Clone)]
pub(crate) struct Settings {
    preparation: Ensurer,
    encryption: Arc<Service>,
    data: PathBuf,
    global: Option<PathBuf>,
    changes: Arc<Changes>,
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
            changes: Arc::default(),
        }
    }

    pub(crate) async fn execute(&self, incoming: &Value) -> Result<Value> {
        let operation = Operation::new(&self.encryption, incoming)?;
        let kind = incoming["type"]
            .as_str()
            .context("Missing skill operation.")?;
        let customization = customizations::Command::find(kind);
        let provider = if customization.is_some() || matches!(kind, CHAT_LIST | CHAT_CONFIGURE) {
            &incoming["provider"]["id"]
        } else {
            &incoming["providerId"]
        };
        ensure!(
            operation.scope["providerId"] == *provider && !provider.is_null(),
            "The skill settings provider changed."
        );
        let changing = customization.is_some_and(customizations::Command::mutating)
            || matches!(
                kind,
                SETTINGS_WRITE | SETTINGS_DELETE | SETTINGS_CONFIGURE | CHAT_CONFIGURE
            );
        if changing {
            self.changes.replay.reserve(&operation)?;
        }
        let (input_schema, output_schema) = match kind {
            CHAT_LIST => (None, "skillListSchema"),
            CHAT_CONFIGURE => (
                Some("codexSkillConfigUpdateSchema"),
                "codexSkillConfigResultSchema",
            ),
            SETTINGS_LIST => (None, "skillSettingsInventorySchema"),
            SETTINGS_READ => (
                Some("skillSettingsReadContentSchema"),
                "skillSettingsDocumentSchema",
            ),
            SETTINGS_WRITE => (
                Some("skillSettingsWriteContentSchema"),
                "skillSettingsMutationResultSchema",
            ),
            SETTINGS_DELETE => (
                Some("skillSettingsDeleteContentSchema"),
                "skillSettingsMutationResultSchema",
            ),
            SETTINGS_CONFIGURE => (
                Some("skillSettingsConfigureContentSchema"),
                "skillSettingsConfigResultSchema",
            ),
            _ => customization
                .expect("Validated customization dispatch")
                .schemas(),
        };
        let input = if let Some(schema) = input_schema {
            operation.open(&incoming["protectedRequest"], schema)?
        } else {
            Value::Null
        };
        let (_mutation, _read) = if changing {
            (Some(self.changes.access.write().await), None)
        } else {
            (None, Some(self.changes.access.read().await))
        };
        operation.assert_current()?;
        let result = self.run(incoming, &operation, kind, &input).await;
        operation.seal(result, output_schema)
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
        if let Some(customization) = customizations::Command::find(kind) {
            let cwd = cwd.context("Missing customization workspace.")?;
            let runtime = self.runtime(incoming, operation).await?;
            return customization
                .run(
                    customizations::Target {
                        runtime: &runtime,
                        cwd,
                        thread: &incoming["threadId"],
                        global: self.global.as_deref(),
                        report: self.preparation.customization_compatibility(),
                        force_reload: incoming["forceReload"] == true,
                        operation,
                    },
                    input,
                )
                .await;
        }
        if kind == CHAT_LIST {
            let cwd = cwd.context("Missing skill workspace.")?;
            let runtime = self.runtime(incoming, operation).await?;
            let (skills, _) = list(&runtime, cwd, false, RPC_TIMEOUT).await?;
            return chat_summary(skills);
        }
        if kind == CHAT_CONFIGURE {
            let cwd = cwd.context("Missing skill workspace.")?;
            let runtime = self.runtime(incoming, operation).await?;
            let path = input["path"]
                .as_js_string()
                .context("Missing skill path.")?;
            return configure(&runtime, cwd, path, input, operation).await;
        }
        let provider = incoming["providerId"]
            .as_js_string()
            .context("Missing skill provider ID.")?;
        let provider_kind = incoming["providerKind"]
            .as_str()
            .context("Missing skill provider kind.")?;
        let roots = library::roots(&self.data, self.global.as_deref(), provider, provider_kind);
        let cwd_path = cwd.map(paths::native);
        if matches!(kind, SETTINGS_READ | SETTINGS_WRITE | SETTINGS_DELETE) {
            let input = input.clone();
            let kind = kind.to_owned();
            let data = self.data.clone();
            let identity = operation.identity().clone();
            let encryption = self.encryption.clone();
            return tokio::task::spawn_blocking(move || {
                let roots = settings_roots(roots, cwd_path.as_deref())?;
                let check = || {
                    ensure!(
                        encryption.bound_identity()? == identity,
                        "The worker binding changed during customization."
                    );
                    Ok(())
                };
                match kind.as_str() {
                    SETTINGS_WRITE => mutations::write(&roots, &input, check),
                    SETTINGS_DELETE => mutations::delete(&roots, &input, &data, check),
                    _ => files::read(roots, &input),
                }
            })
            .await?;
        }
        let fallback = paths::text(&self.data);
        let cwd = cwd.unwrap_or(&fallback);
        if kind == SETTINGS_CONFIGURE {
            let id = input["skillId"].clone();
            let path = tokio::task::spawn_blocking(move || {
                let roots = settings_roots(roots, cwd_path.as_deref())?;
                let (_, skill) = files::select(&roots, &id, false)?;
                Ok::<_, anyhow::Error>(paths::text(&skill.directory.join("SKILL.md")))
            })
            .await??;
            let runtime = self.runtime(incoming, operation).await?;
            let configured = configure(&runtime, cwd, &path, input, operation).await?;
            return Ok(
                json!({"skillId":input["skillId"],"effectiveEnabled":configured["effectiveEnabled"]}),
            );
        }
        let (native, errors) = if incoming["model"].is_null() || incoming["provider"].is_null() {
            (Vec::new(), Vec::new())
        } else {
            let runtime = self.runtime(incoming, operation).await?;
            list(&runtime, cwd, true, RPC_TIMEOUT).await?
        };
        tokio::task::spawn_blocking(move || {
            inventory(settings_roots(roots, cwd_path.as_deref())?, native, errors)
        })
        .await?
    }

    async fn runtime(&self, command: &Value, operation: &Operation<'_>) -> Result<Runtime> {
        let provider = open_runtime_provider(&self.encryption, &command["provider"])?;
        ensure!(
            provider["id"] == operation.scope["providerId"],
            "The skill runtime provider changed."
        );
        self.preparation
            .inspection_runtime(
                &command["model"],
                provider,
                operation.identity(),
                operation.scope["chatId"].as_js_string(),
                command["threadId"].as_js_string(),
            )
            .await
    }
}

async fn configure(
    runtime: &Runtime,
    cwd: &JsString,
    path: &JsString,
    input: &Value,
    operation: &Operation<'_>,
) -> Result<Value> {
    let expected = paths::resolve(&paths::native(path))?;
    let (skills, _) = list(runtime, cwd, true, RPC_TIMEOUT).await?;
    let path = skills
        .iter()
        .filter_map(native_skill_path)
        .find(|path| {
            paths::resolve(&paths::native(path))
                .is_ok_and(|candidate| paths::equal(&candidate, &expected))
        })
        .context(
            "The requested skill path is not present in this project's native Codex inventory.",
        )?;
    operation.assert_current()?;
    let response = runtime
        .request(
            "skills/config/write".into(),
            Some(json!({"path":path,"enabled":input["enabled"]})),
            Some(RPC_TIMEOUT),
            None,
        )
        .await?;
    let enabled = response
        .and_then(|value| value["effectiveEnabled"].as_bool())
        .context("Codex returned an invalid skill configuration result.")?;
    Ok(json!({"path":path,"effectiveEnabled":enabled}))
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

pub(in crate::codex) fn sorting() -> Result<CollatorBorrowed<'static>> {
    let locale: icu_locale_core::Locale = cantrip_wire::environment::locale()
        .unwrap_or("en-US")
        .parse()
        .unwrap_or_else(|_| "en-US".parse().unwrap());
    Collator::try_new(locale.into(), CollatorOptions::default())
        .map_err(|e| anyhow::anyhow!("Skill sorting locale: {e}"))
}

pub(in crate::codex) fn compare(
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

pub(in crate::codex) fn native_skill_path(skill: &Value) -> Option<&JsString> {
    let path = skill["path"]
        .as_js_string()
        .filter(|path| !path.is_empty())?;
    (skill["name"]
        .as_js_string()
        .is_some_and(|name| !name.trim().is_empty())
        && matches!(
            skill["scope"].as_str(),
            Some("user" | "repo" | "system" | "admin")
        ))
    .then_some(path)
}

fn inventory(roots: Vec<Root>, native: Vec<Value>, errors: Vec<Value>) -> Result<Value> {
    let mut enabled = HashMap::new();
    for skill in native {
        if let Some(path) = native_skill_path(&skill) {
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
