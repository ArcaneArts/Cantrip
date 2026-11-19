//! Checkout and observation inside the selected Linux workspace.
use super::{
    checked,
    operations::{Journal, digest},
    process::command,
    session::{Session, file_path, file_uri},
    text,
};
use crate::{encryption::Service, routing::Registry};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use cantrip_wire::{Value, value::json};
use url::Url;

const PUBLISH: &str = r#"
import ctypes,os,sys
libc=ctypes.CDLL(None,use_errno=True)
if libc.renameat2(-100,os.fsencode(sys.argv[1]),-100,os.fsencode(sys.argv[2]),1):
    code=ctypes.get_errno()
    raise OSError(code,os.strerror(code))
"#;

pub(super) async fn intent(
    command: &Value,
    scope: &Value,
    encryption: &Service,
    routing: &Registry,
) -> Result<Value> {
    ensure!(
        scope["ownerId"].as_js_string() == Some(&encryption.owner_id()?),
        "OS source encryption belongs to a different owner."
    );
    let admitted = crate::protected_content::open_repository_content(
        encryption,
        &json!({"serverId":scope["serverId"],"projectId":scope["projectId"],
            "worktreeId":scope["worktreeId"],"operationId":command["operationId"],"direction":"request"}),
        &command["protectedRequest"],
        "cantripOsProvisionRequestContentSchema",
        true,
    )?;
    ensure!(
        [
            "instanceId",
            "workspaceId",
            "bindingId",
            "bindingGeneration"
        ]
        .into_iter()
        .all(|field| admitted[field] == scope[field]),
        "Protected OS source intent does not match its admitted placement."
    );
    let mut intent = admitted["intent"].clone();
    ensure!(
        intent["mode"] == scope["mode"],
        "Source mode changed after admission."
    );
    if intent["mode"] == "linked" {
        intent["workerPath"] = routing.resolve(&intent["workerPath"]).await?;
        ensure!(
            intent["workerPath"] == scope["linkedWorkerPath"]
                && intent["dependencyOverlays"] == scope["dependencyOverlays"],
            "Linked mount admission does not match its canonical source."
        );
        return Ok(intent);
    }
    let source = &mut intent["source"];
    let kind = match text(source, "kind")? {
        "existing" => text(source, "sourceKind")?,
        "git-worktree" => "git",
        kind => kind,
    };
    ensure!(
        scope["sourceKind"] == kind,
        "Source kind changed after admission."
    );
    if source["kind"] == "git" {
        source["repositoryUrl"] = routing.resolve(&source["repositoryUrl"]).await?;
        // The resolved original is used for Git and the compatible admission digest.
        checked("cantripOsProvisionIntentSchema", intent.clone())?;
    }
    Ok(intent)
}

pub(super) struct Source<'a> {
    scope: &'a Value,
    id: &'a str,
    path: &'a str,
    kind: &'a str,
    home: &'a str,
}

impl<'a> Source<'a> {
    pub fn new(scope: &'a Value) -> Result<Self> {
        ensure!(
            scope["mode"] == "linux-owned",
            "Expected a Linux-owned source."
        );
        Ok(Self {
            scope,
            id: text(scope, "projectSourceId")?,
            path: text(scope, "guestPath")?,
            kind: text(scope, "sourceKind")?,
            home: text(scope, "homeGuestPath")?,
        })
    }

    pub async fn provision(
        &self,
        session: &mut Session<'_>,
        operation_id: &str,
        intent: &Value,
        journal: &mut Journal<'_>,
    ) -> Result<Value> {
        ensure!(
            self.scope["dependencyOverlays"]
                .as_array()
                .is_some_and(Vec::is_empty),
            "Linux-owned provisioning requires its selected Linux source."
        );
        let source = &intent["source"];
        let metadata = match text(source, "kind")? {
            "existing" => {
                self.observe(session, self.path, true, Some(journal))
                    .await?
            }
            "git-worktree" => self.worktree(session, source, journal).await?,
            _ => {
                self.checkout(session, operation_id, source, journal)
                    .await?
            }
        };
        Ok(json!({"kind":"source","source":self.receipt(session, &metadata)?}))
    }

    pub async fn inspect(&self, session: &mut Session<'_>) -> Result<Value> {
        let metadata = self.observe(session, self.path, false, None).await?;
        self.receipt(session, &metadata)
    }

    fn receipt(&self, session: &Session<'_>, metadata: &Value) -> Result<Value> {
        checked(
            "cantripOsSourceReceiptSchema",
            json!({
                "bindingId":self.scope["bindingId"], "workspaceId":self.scope["workspaceId"],
                "guestWorkspaceId":self.scope["guestWorkspaceId"], "mode":self.scope["mode"],
                "guestPath":metadata["guestPath"], "runtimeGeneration":session.binding["generation"],
                "uid":session.binding["uid"], "homeGuestPath":session.binding["home"],
                "recreated":false, "interruptedGuestWorkspaces":Vec::<Value>::new(),
                "dependencyOverlays":self.scope["dependencyOverlays"], "cleanupWarnings":Vec::<Value>::new(),
                "head":metadata["head"], "branch":metadata["branch"], "detached":metadata["detached"],
                "gitCommonGuestPath":metadata["gitCommonGuestPath"],
                "repositoryFingerprint":metadata["repositoryFingerprint"],
            }),
        )
    }

    async fn observe(
        &self,
        session: &mut Session<'_>,
        path: &str,
        root: bool,
        mut journal: Option<&mut Journal<'_>>,
    ) -> Result<Value> {
        let canonical = session
            .request(
                "fs/canonicalize",
                json!({
                    "path":file_uri(path)?.as_str(),"sandbox":Value::Null
                }),
            )
            .await?;
        let uri = Url::parse(text(&canonical, "path")?)?;
        ensure!(
            file_path(&uri)? == path,
            "The source's canonical Linux location changed."
        );
        let metadata = session
            .request(
                "fs/getMetadata",
                json!({
                    "path":uri.as_str(),"followSymlinks":true,"sandbox":Value::Null
                }),
            )
            .await?;
        ensure!(
            metadata["isDirectory"].as_bool() == Some(true),
            "The selected Linux source is not a directory."
        );
        if self.kind == "git" && root {
            let root = command(
                session,
                journal.as_deref_mut(),
                &["git", "-C", path, "rev-parse", "--show-toplevel"],
                path,
            )
            .await?;
            ensure!(
                root == path,
                "Select the Git worktree root when registering an existing repository."
            );
        }
        self.metadata(session, path, journal).await
    }

    async fn metadata(
        &self,
        session: &mut Session<'_>,
        path: &str,
        mut journal: Option<&mut Journal<'_>>,
    ) -> Result<Value> {
        if self.kind == "folder" {
            return Ok(
                json!({"sourceId":self.id,"guestPath":path,"sourceKind":"folder",
                "head":Value::Null,"branch":Value::Null,"detached":false,
                "gitCommonGuestPath":Value::Null,"repositoryFingerprint":Value::Null}),
            );
        }
        let head = command(
            session,
            journal.as_deref_mut(),
            &["git", "-C", path, "rev-parse", "--verify", "HEAD^{commit}"],
            path,
        )
        .await?;
        let branch = command(
            session,
            journal.as_deref_mut(),
            &["git", "-C", path, "branch", "--show-current"],
            path,
        )
        .await?;
        let common = command(
            session,
            journal,
            &[
                "git",
                "-C",
                path,
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
            ],
            path,
        )
        .await?;
        checked("cantripOsGuestPathSchema", json!(common))?;
        let fingerprint = digest(json!({"instance":session.binding["instance_id"],
            "workspace":session.binding["workspace_id"],"common":common}));
        Ok(
            json!({"sourceId":self.id,"guestPath":path,"sourceKind":"git",
            "head":head,"branch":(!branch.is_empty()).then_some(&branch),"detached":branch.is_empty(),
            "gitCommonGuestPath":common,"repositoryFingerprint":fingerprint}),
        )
    }

    async fn checkout(
        &self,
        session: &mut Session<'_>,
        operation_id: &str,
        source: &Value,
        journal: &mut Journal<'_>,
    ) -> Result<Value> {
        let home = self.home.trim_end_matches('/');
        let checkouts = format!("{home}/checkouts");
        ensure!(
            self.path == format!("{checkouts}/{}", self.id),
            "Managed source location does not match the selected workspace."
        );
        let reservations = format!("{home}/.local/state/cantrip-os-source-operations");
        let reservation = format!("{reservations}/{operation_id}");
        let staging = format!("{reservation}/checkout");
        mkdir(session, &checkouts, true).await?;
        mkdir(session, &reservations, true).await?;
        // Keep a once-only reservation and the evidence of an interrupted checkout.
        mkdir(session, &reservation, false).await?;
        let plan = json!({"sourceId":self.id,"operationId":operation_id,"guestPath":self.path,
            "sourceKind":self.kind,"repositoryUrl":source["repositoryUrl"],"revision":source["revision"]});
        write(session, &format!("{reservation}/intent.json"), &plan).await?;
        mkdir(session, &staging, false).await?;
        if self.kind == "git" {
            let url = text(source, "repositoryUrl")?;
            let revision = text(source, "revision")?;
            command(
                session,
                Some(journal),
                &[
                    "git",
                    "clone",
                    "--no-checkout",
                    "--no-local",
                    "--",
                    url,
                    &staging,
                ],
                self.home,
            )
            .await?;
            command(
                session,
                Some(journal),
                &["git", "-C", &staging, "checkout", "--detach", revision],
                &staging,
            )
            .await?;
            let head = command(
                session,
                Some(journal),
                &[
                    "git",
                    "-C",
                    &staging,
                    "rev-parse",
                    "--verify",
                    "HEAD^{commit}",
                ],
                &staging,
            )
            .await?;
            ensure!(
                head.eq_ignore_ascii_case(revision),
                "Provisioned Git revision did not match the admitted commit."
            );
        }
        // The executor has no rename RPC. Publish atomically on the guest
        // filesystem and let the actual rename refuse any existing target.
        command(
            session,
            Some(journal),
            &["python3", "-c", PUBLISH, &staging, self.path],
            self.home,
        )
        .await?;
        let receipt = self.metadata(session, self.path, Some(journal)).await?;
        write(session, &format!("{reservation}/result.json"), &receipt).await?;
        Ok(receipt)
    }

    async fn worktree(
        &self,
        session: &mut Session<'_>,
        source: &Value,
        journal: &mut Journal<'_>,
    ) -> Result<Value> {
        let home = self.home.trim_end_matches('/');
        let default = format!("{home}/checkouts/{}", self.id);
        let primary = self.scope["primaryGuestPath"].as_str().unwrap_or(&default);
        let normalized = file_path(&file_uri(primary)?)?;
        ensure!(
            normalized == self.home || normalized.starts_with(&format!("{home}/")),
            "The Primary source is outside its selected Linux workspace."
        );
        let parent = format!("{home}/worktrees");
        ensure!(
            self.path == format!("{parent}/{}", text(self.scope, "worktreeId")?),
            "Worktree locations do not match the selected workspace."
        );
        let expected = text(self.scope, "repositoryFingerprint")?;
        let actual = self.observe(session, primary, true, Some(journal)).await?;
        ensure!(
            actual["repositoryFingerprint"] == expected,
            "The Linux Git common directory changed; no worktree mutation was started."
        );
        mkdir(session, &parent, true).await?;
        let mut argv = vec!["git", "-C", primary, "worktree", "add"];
        if let Some(branch) = source["branch"].as_str() {
            argv.extend(["-b", branch]);
        } else {
            argv.push("--detach");
        }
        argv.extend(["--", self.path, text(source, "revision")?]);
        command(session, Some(journal), &argv, self.home).await?;
        self.metadata(session, self.path, Some(journal)).await
    }
}

async fn mkdir(session: &mut Session<'_>, path: &str, recursive: bool) -> Result<()> {
    session
        .request(
            "fs/createDirectory",
            json!({
                "path":file_uri(path)?.as_str(),"recursive":recursive,"sandbox":Value::Null
            }),
        )
        .await?;
    Ok(())
}

async fn write(session: &mut Session<'_>, path: &str, content: &Value) -> Result<()> {
    session.request("fs/writeFile", json!({
        "path":file_uri(path)?.as_str(),"dataBase64":STANDARD.encode(content.stringify()),"sandbox":Value::Null
    })).await?;
    Ok(())
}
