//! Worker-owned reconciliation of a folder with the selected GitHub repository.
mod journal;

use super::{api, process};
use crate::{
    filesystem::{Scope, folders, paths, repository::github_repository_from_remote, source_path},
    http::checked,
    replicas::git,
    routing::Registry,
};
use anyhow::{Context, Result, ensure};
use cantrip_wire::{JsString, Value, value::json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
};
use tokio::sync::Mutex as Queue;

const MAXIMUM: usize = 32 * 1024 * 1024;
const AUTH: &str = "credential.helper=!gh auth git-credential";

pub(crate) fn supports(kind: &str) -> bool {
    matches!(
        kind,
        "project.folder-conversion.preflight" | "project.folder-conversion.execute"
    )
}

pub(crate) struct Converter {
    folders: Arc<folders::Manager>,
    data: PathBuf,
    queues: Mutex<HashMap<PathBuf, Weak<Queue<()>>>>,
}

struct Local {
    branch: Option<JsString>,
    head: Option<JsString>,
    origin: Option<JsString>,
    dirty: bool,
    kind: &'static str,
    status_fingerprint: String,
}

struct Repository {
    wire: Value,
    name: JsString,
    default_branch: JsString,
    origin: String,
}

struct Target {
    path: PathBuf,
    display: JsString,
}

#[derive(Debug)]
struct Blocked {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

impl std::fmt::Display for Blocked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for Blocked {}

fn failure(code: &'static str, message: &'static str, retryable: bool) -> anyhow::Error {
    Blocked {
        code,
        message,
        retryable,
    }
    .into()
}

fn unavailable(message: &'static str) -> anyhow::Error {
    failure("repository-unavailable", message, true)
}

fn ambiguous(message: &'static str) -> anyhow::Error {
    failure("local-git-ambiguous", message, false)
}

fn changed() -> anyhow::Error {
    failure(
        "preflight-changed",
        "The local Git state changed after preflight. Run conversion preflight again before retrying.",
        false,
    )
}

fn nonempty() -> anyhow::Error {
    failure(
        "repository-not-empty",
        "The selected GitHub repository does not contain this checkout's current branch at the same commit. Cantrip did not push, merge, or overwrite it.",
        false,
    )
}

fn initial_commit() -> anyhow::Error {
    failure(
        "initial-commit-required",
        "This repository has no commits. Confirm an initial commit before converting.",
        false,
    )
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl Local {
    fn confirmation(&self, project: &Value, repository: &Value) -> String {
        // The legacy token hashes JSON in this property order.
        digest(
            &json!({
                "branch":self.branch,"dirty":self.dirty,"head":self.head,"localState":self.kind,
                "originUrl":self.origin,"projectId":project,"repository":repository,
                "statusFingerprint":self.status_fingerprint
            })
            .stringify(),
        )
    }

    async fn inspect(root: &Path, scope: &Scope) -> Result<Self> {
        let result = async {
            match tokio::fs::symlink_metadata(root.join(".git")).await {
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    return Ok(Self {
                        branch: None, head: None, origin: None, dirty: false,
                        kind: "not-initialized", status_fingerprint: "not-initialized".into(),
                    });
                }
                Ok(entry) if entry.is_dir() => {}
                Ok(_) => return Err(ambiguous(
                    "The managed folder has a linked or unsafe .git entry. Conversion only accepts a repository rooted directly in this folder.",
                )),
                Err(error) => return Err(error.into()),
            }
            let top = git::directory(root, "--show-toplevel", scope).await?;
            let common = git::directory(root, "--git-common-dir", scope).await?;
            if top != root || common != root.join(".git") {
                return Err(ambiguous("The local Git repository is rooted outside the selected project source."));
            }
            let remotes = git::run(root, &["remote"], MAXIMUM, scope).await?;
            if !remotes.is_empty() && remotes.as_str() != Some("origin") {
                return Err(ambiguous(
                    "The local Git repository has an ambiguous remote configuration. Conversion accepts no remotes or one remote named origin.",
                ));
            }
            let origin = if remotes.is_empty() {
                None
            } else {
                let url = git::run(root, &["config", "--get-all", "remote.origin.url"], MAXIMUM, scope).await?;
                if url.is_empty() || url.units().iter().any(|unit| matches!(unit, 10 | 13)) {
                    return Err(ambiguous("The origin does not identify a single GitHub repository."));
                }
                Some(url)
            };
            let head = git::commit(root, "HEAD", scope).await;
            let mut branch = git::run(root, &["branch", "--show-current"], MAXIMUM, scope)
                .await.ok().filter(|branch| !branch.is_empty());
            if branch.is_none() && head.is_none() {
                branch = git::run(root, &["symbolic-ref", "--short", "HEAD"], MAXIMUM, scope)
                    .await.ok().filter(|branch| !branch.is_empty());
            }
            if head.is_some() && branch.is_none() {
                return Err(ambiguous("The local Git repository has a detached HEAD. Choose a branch before converting."));
            }
            let status = git::run(root, &["status", "--porcelain=v1", "--untracked-files=all"], MAXIMUM, scope).await?;
            Ok(Self {
                branch, origin, dirty: !status.is_empty(),
                kind: if head.is_some() { "committed" } else { "unborn" },
                head, status_fingerprint: digest(&status.lossy()),
            })
        }.await;
        result.map_err(|error| {
            if error.is::<Blocked>() {
                error
            } else {
                ambiguous("The local Git state is not safe for automatic conversion.")
            }
        })
    }

    fn branch_ref(&self) -> Result<JsString> {
        let branch = self
            .branch
            .as_ref()
            .filter(|_| self.head.is_some())
            .ok_or_else(|| {
                ambiguous("Conversion requires a named local branch with at least one commit.")
            })?;
        Ok(api::prefix("refs/heads/", branch))
    }
}

impl Repository {
    async fn verify(input: &Value, scope: &Scope) -> Result<Self> {
        let verified = async {
            let name = input["nameWithOwner"]
                .as_js_string()
                .context("Missing repository name.")?;
            let api_path = api::repository_path(name)?;
            let info = api::request(&api_path, &[], scope).await?;
            let wire = checked(
                "projectGithubConversionRepositorySchema",
                &json!({
                    "repositoryId":api::string(&info, "id")?,
                    "nameWithOwner":api::string(&info, "full_name")?,
                    "url":api::string(&info, "html_url")?
                }),
            )?;
            let actual = wire["nameWithOwner"].as_js_string().unwrap();
            ensure!(
                wire["repositoryId"] == input["repositoryId"]
                    && wire["url"] == input["url"]
                    && actual.lowercase() == name.lowercase(),
                "GitHub repository identity changed."
            );
            let default_branch = if cantrip_wire::coercion::truthy(info.get("default_branch")) {
                api::text(info.get("default_branch"))?.trim()
            } else {
                "main".into()
            };
            let text = default_branch.lossy();
            ensure!(
                !text.is_empty() && !text.starts_with('-') && !text.contains(".."),
                "GitHub repository default branch is invalid."
            );
            Ok::<_, anyhow::Error>(Self {
                name: actual.clone(),
                default_branch,
                origin: format!("https://github.com/{actual}.git"),
                wire,
            })
        }
        .await;
        verified
            .map_err(|_| unavailable("The worker could not verify the selected GitHub repository."))
    }

    fn matches(&self, url: &JsString) -> bool {
        github_repository_from_remote(url).is_some_and(|name| name == self.name.lowercase())
    }

    async fn empty(&self, scope: &Scope) -> Result<bool> {
        let name = self.name.as_str().unwrap();
        let (owner, name) = name.split_once('/').unwrap();
        let info = api::request("graphql", &[
            "-f".into(), "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){isEmpty}}".into(),
            "-f".into(), format!("owner={owner}").into(),
            "-f".into(), format!("name={name}").into(),
        ], scope).await.map_err(|_| unavailable("The worker could not inspect the GitHub repository history."))?;
        info["data"]["repository"]["isEmpty"]
            .as_bool()
            .ok_or_else(|| unavailable("GitHub did not return the repository history state."))
    }

    async fn refs(&self, root: &Path, scope: &Scope) -> Result<HashMap<JsString, JsString>> {
        let output = git::run(
            root,
            &["-c", AUTH, "ls-remote", "--heads", "--tags", &self.origin],
            MAXIMUM,
            scope,
        )
        .await
        .map_err(|_| unavailable("Git could not inspect the remote refs."))?;
        output
            .lossy()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                let mut columns = line.split_whitespace();
                let revision = columns.next().context("Missing Git revision.")?;
                let name = columns.next().context("Missing Git ref.")?;
                ensure!(columns.next().is_none(), "Invalid Git ref.");
                Ok((name.into(), revision.to_ascii_lowercase().into()))
            })
            .collect::<Result<_>>()
            .map_err(|_| unavailable("Git returned invalid remote refs."))
    }

    async fn push(&self, root: &Path, branch: &JsString, scope: &Scope) -> Result<()> {
        // Compare the URLs Git will actually use, including local insteadOf
        // rules. A custom push route must still lead to this repository.
        let resolved = git::run(
            root,
            &["ls-remote", "--get-url", &self.origin],
            MAXIMUM,
            scope,
        )
        .await
        .map_err(|_| unavailable("Git could not resolve the verified repository URL."))?;
        let destinations = git::run(
            root,
            &["remote", "get-url", "--push", "--all", "origin"],
            MAXIMUM,
            scope,
        )
        .await
        .map_err(|_| ambiguous("Git could not resolve the origin push URL."))?;
        let urls: HashSet<_> = destinations.lossy().lines().map(JsString::from).collect();
        if urls.len() != 1
            || urls
                .iter()
                .any(|url| url != &resolved && !self.matches(url))
        {
            return Err(ambiguous(
                "The origin push URL differs from the verified GitHub repository.",
            ));
        }
        let args = vec![
            "-C".into(),
            paths::text(root),
            "-c".into(),
            AUTH.into(),
            "push".into(),
            "--set-upstream".into(),
            "--no-follow-tags".into(),
            "--no-recurse-submodules".into(),
            "origin".into(),
            format!("{branch}:{branch}").into(),
        ];
        process::run_program("git", &args, MAXIMUM, scope)
            .await
            .map_err(|_| {
                failure(
                    "push-failed",
                    "Git could not push the local branch to GitHub.",
                    true,
                )
            })?;
        Ok(())
    }
}

impl Converter {
    pub(crate) fn new(data: &Path, folders: Arc<folders::Manager>) -> Self {
        Self {
            folders,
            data: data.to_owned(),
            queues: Mutex::default(),
        }
    }

    async fn target(&self, input: &Value, scope: &Scope) -> Result<Target> {
        let resolved = if let Some(path) = input["sourcePath"].as_js_string() {
            json!({"path":paths::text(&source_path::canonical(path).await?),"displayPath":input["sourceDisplayPath"]})
        } else {
            self.folders
                .resolve(
                    input["projectId"].as_js_string().unwrap(),
                    &input["workspaceStorage"],
                    scope,
                )
                .await?
        };
        Ok(Target {
            path: paths::native(
                resolved["path"]
                    .as_js_string()
                    .context("Missing folder path.")?,
            ),
            display: resolved["displayPath"]
                .as_js_string()
                .filter(|display| !display.is_empty())
                .cloned()
                .context("Missing folder display path.")?,
        })
    }

    pub(crate) async fn execute_routed(
        &self,
        command: &Value,
        registry: &Registry,
        scope: &Scope,
    ) -> Result<Value> {
        let kind = command["type"].as_str().unwrap();
        let answer = async {
            let input = registry.resolve(command).await?;
            let preflight = kind.ends_with(".preflight");
            let result = self.convert(&input, preflight, scope).await;
            scope.check()?;
            let result = match result {
                Ok(value) => value,
                Err(error) => {
                    let other = Blocked {
                        code: "reconciliation-failed",
                        message: "The worker could not reconcile the local folder with GitHub.",
                        retryable: false,
                    };
                    let failure = error.downcast_ref::<Blocked>().unwrap_or(&other);
                    if preflight {
                        json!({"status":"blocked","projectId":input["projectId"],"repository":input["repository"],
                            "error":json!({"code":failure.code,"message":failure.message,"retryable":failure.retryable})})
                    } else {
                        json!({"status":"blocked","jobId":input["jobId"],"attempt":input["attempt"],
                            "error":json!({"code":failure.code,"retryable":failure.retryable})})
                    }
                }
            };
            let result = registry.protect_result(kind, &result).await?;
            checked(if preflight { "projectGithubConversionPreflightResultSchema" }
                else { "projectGithubConversionExecutionResultSchema" }, &result)
        }.await;
        answer.map_err(|error| crate::routing::protect_error(kind, error))
    }

    async fn convert(&self, input: &Value, preflight: bool, scope: &Scope) -> Result<Value> {
        let repository = Repository::verify(&input["repository"], scope).await?;
        let target = self
            .target(input, scope)
            .await
            .map_err(|_| ambiguous("The selected project folder is unavailable."))?;
        let queue = {
            let mut queues = self.queues.lock().unwrap();
            queues.retain(|_, queue| queue.strong_count() > 0);
            let queue = queues
                .get(&target.path)
                .and_then(Weak::upgrade)
                .unwrap_or_default();
            queues.insert(target.path.clone(), Arc::downgrade(&queue));
            queue
        };
        let _guard = tokio::select! {
            _ = scope.stopped() => anyhow::bail!("Folder conversion stopped."),
            guard = queue.lock() => guard,
        };
        let local = Local::inspect(&target.path, scope).await?;
        if local
            .origin
            .as_ref()
            .is_some_and(|origin| !repository.matches(origin))
        {
            return Err(ambiguous(
                "The local origin differs from the selected GitHub repository.",
            ));
        }
        let empty = repository.empty(scope).await?;
        if preflight {
            self.preview(input, &target, &repository, local, empty, scope)
                .await
        } else {
            self.publish(input, &target, &repository, local, empty, scope)
                .await
        }
    }

    async fn preview(
        &self,
        input: &Value,
        target: &Target,
        repository: &Repository,
        local: Local,
        empty: bool,
        scope: &Scope,
    ) -> Result<Value> {
        if !empty {
            verify_link(&local, &repository.refs(&target.path, scope).await?)?;
        }
        let mut warnings = vec![
            "Conversion is one-way in V1.",
            "Cantrip will never force-push or merge unrelated remote history.",
        ];
        if empty {
            if local.dirty && local.head.is_some() {
                warnings.push("Uncommitted local changes will remain uncommitted; only the current branch history will be pushed.");
            }
            if local.head.is_none() {
                warnings.push("An initial commit containing the current folder contents is required before the empty repository can be pushed.");
            }
        } else {
            warnings.push("The existing GitHub branch exactly matches this checkout. Cantrip will link it without pushing or rewriting remote history.");
        }
        let confirmation = local.confirmation(&input["projectId"], &repository.wire);
        Ok(
            json!({"status":"ready","projectId":input["projectId"],"repository":repository.wire,
            "confirmationToken":confirmation,"localState":local.kind,"branch":local.branch,
            "head":local.head,"dirty":local.dirty,"originUrl":local.origin,
            "remoteAction":if empty {"push"} else {"link"},
            "requiresInitialCommit":empty && local.head.is_none(),"warnings":warnings}),
        )
    }

    async fn publish(
        &self,
        input: &Value,
        target: &Target,
        repository: &Repository,
        mut local: Local,
        empty: bool,
        scope: &Scope,
    ) -> Result<Value> {
        let root = &target.path;
        let mut journal = journal::Journal::new(&self.data, root, input, &repository.wire)?;
        journal.check_head(local.branch.as_ref(), local.head.as_ref())?;
        let refs = repository.refs(root, scope).await?;
        if !empty || !refs.is_empty() {
            verify_link(&local, &refs)?;
        } else {
            if !journal.resumes()
                && input["confirmationToken"]
                    != local
                        .confirmation(&input["projectId"], &repository.wire)
                        .as_str()
            {
                return Err(changed());
            }
            let commit = input["initialCommit"]["message"].as_js_string();
            if local.head.is_none() && commit.is_none() {
                return Err(initial_commit());
            }
            scope.check()?;
            // Persist the receipt before git init so a stopped worker can
            // resume the same confirmed job even if .git did not exist yet.
            journal.record(
                local.branch.as_ref().unwrap_or(&repository.default_branch),
                local.head.as_ref(),
            )?;
            if local.kind == "not-initialized" {
                git::run(
                    root,
                    &["init", "-b", &repository.default_branch.lossy()],
                    MAXIMUM,
                    scope,
                )
                .await
                .map_err(|_| {
                    failure(
                        "git-initialization-failed",
                        "Git could not be initialized in the folder.",
                        true,
                    )
                })?;
                local = Local::inspect(root, scope).await?;
            }
            journal.write_legacy()?;
            if local.origin.is_none() {
                git::run(
                    root,
                    &["remote", "add", "origin", &repository.origin],
                    MAXIMUM,
                    scope,
                )
                .await
                .map_err(|_| {
                    failure(
                        "git-initialization-failed",
                        "Git could not bind the origin remote.",
                        true,
                    )
                })?;
            }
            if local.head.is_none() {
                let message = commit.unwrap().lossy();
                async {
                    git::run(root, &["add", "--all"], MAXIMUM, scope).await?;
                    git::run(
                        root,
                        &["commit", "--allow-empty", "-m", &message],
                        MAXIMUM,
                        scope,
                    )
                    .await
                }
                .await
                .map_err(|_| {
                    failure(
                        "commit-failed",
                        "Git could not create the explicitly approved initial commit.",
                        true,
                    )
                })?;
            }
            local = Local::inspect(root, scope).await?;
            let branch = local.branch_ref()?;
            if !local
                .origin
                .as_ref()
                .is_some_and(|origin| repository.matches(origin))
            {
                return Err(ambiguous("The local origin changed during conversion."));
            }
            scope.check()?;
            journal.check_head(local.branch.as_ref(), local.head.as_ref())?;
            journal.record(local.branch.as_ref().unwrap(), local.head.as_ref())?;
            let refs = repository.refs(root, scope).await?;
            if refs.is_empty() {
                repository.push(root, &branch, scope).await?;
            } else {
                verify_link(&local, &refs)?;
            }
        }
        let branch = local.branch_ref()?;
        let verified = repository.refs(root, scope).await?;
        if verified.get(&branch) != local.head.as_ref() {
            return Err(failure(
                "reconciliation-failed",
                "The pushed GitHub branch could not be reconciled exactly. Cantrip did not enable Git capabilities.",
                false,
            ));
        }
        let common = git::directory(root, "--git-common-dir", scope).await?;
        ensure!(
            common == root.join(".git"),
            "The local repository changed during conversion."
        );
        let policy = git::policy(root).await;
        scope.check()?;
        journal.finish()?;
        Ok(
            json!({"status":"ready","jobId":input["jobId"],"attempt":input["attempt"],"repository":repository.wire,
            "path":paths::text(root),"displayPath":target.display,"repositoryFingerprint":digest(&paths::text(&common).lossy()),
            "branch":local.branch,"head":local.head,
            "worktreePolicy":if policy.is_null() { json!("agent-managed") } else { policy }}),
        )
    }
}

fn verify_link(local: &Local, refs: &HashMap<JsString, JsString>) -> Result<()> {
    if local.origin.is_none()
        || local.branch_ref().ok().and_then(|branch| refs.get(&branch)) != local.head.as_ref()
        || local.head.is_none()
    {
        return Err(nonempty());
    }
    Ok(())
}
