//! Tag objects, bounded remote advertisement/verification and reviewed actions.
use super::{
    GitError, branches::render, error_message, process, remotes, review, signatures, status,
};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_crypto::checked;
use cantrip_wire::{JsString, Value, value::json};
use futures::StreamExt;
use indexmap::{IndexMap, IndexSet};
use std::path::Path;

const FORMAT: &str = "%(refname:short)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(contents:subject)%00%(taggername)%00%(creatordate:iso-strict)%00%(signature:grade)%00%(signature:signer)%00%(signature:key)%00%(signature:fingerprint)%00%(contents:signature)%1e";
const FALLBACK: &str = "%(refname:short)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(contents:subject)%00%(taggername)%00%(creatordate:iso-strict)%00N%00%00%00%00%(contents:signature)%1e";
fn slice(value: &JsString, maximum: usize) -> JsString {
    JsString::new(value.units().iter().take(maximum).copied().collect())
}
fn failure(pattern: &str, args: &[&JsString]) -> anyhow::Error {
    GitError(render(pattern, args)).into()
}
fn matches(pattern: &str, text: &JsString, flags: &str) -> bool {
    regress::Regex::with_flags(pattern, flags)
        .unwrap()
        .find_from_utf16(text.units(), 0)
        .next()
        .is_some()
}
fn verification_result(signature: &Value, success: bool, output: &JsString) -> Value {
    let gpg = |status: &str| matches(&format!(r"^\[GNUPG:\] (?:{status})(?: |$)"), output, "mu");
    let ssh = signature["format"] == "ssh";
    let code = if gpg("BADSIG")
        || (ssh
            && matches(
                "signature verification failed: incorrect signature",
                output,
                "iu",
            )) {
        "B"
    } else if gpg("REVKEYSIG") {
        "R"
    } else if gpg("EXPSIG|EXPKEYSIG") {
        "X"
    } else if success {
        if gpg("TRUST_UNDEFINED|TRUST_NEVER") {
            "U"
        } else {
            "G"
        }
    } else if ssh
        && matches("^Good \"git\" signature ", output, "mu")
        && matches("No principal matched", output, "iu")
    {
        "U"
    } else {
        "E"
    };
    let mut result = signature.clone();
    result["status"] = json!(signatures::status(code));
    result["verification"] = json!(if gpg("NO_PUBKEY") {
        "missing-key"
    } else {
        signatures::verification(code, &output.lossy())
    });
    result["verificationMessage"] = if output.is_empty() {
        Value::Null
    } else {
        Value::String(slice(output, 10_000))
    };
    result
}
async fn verify(cwd: &Path, tag: &mut Value, scope: &Scope) -> Result<()> {
    if tag["annotated"] != true || tag["signature"]["status"] == "unsigned" {
        return Ok(());
    }
    // Signature atoms can describe the target commit. Verify the tag object by
    // its immutable hash, never by an option-like or mutable reference name.
    let outcome = Box::pin(process::run_bounded(
        cwd,
        &["verify-tag", "--raw", tag["hash"].as_str().unwrap()],
        scope,
    ))
    .await;
    scope.check()?;
    let success = outcome.is_ok();
    let output = outcome
        .map(JsString::from)
        .unwrap_or_else(|e| error_message(&e));
    tag["signature"] = verification_result(&tag["signature"], success, &output);
    Ok(())
}
pub async fn list(cwd: &Path, scope: &Scope) -> Result<Value> {
    let (refs, remotes) = tokio::join!(
        async {
            let format = format!("--format={FORMAT}");
            match process::raw(cwd, &["for-each-ref", &format, "refs/tags"], scope).await {
                Ok(value) => Ok(value),
                Err(_) => {
                    scope.check()?;
                    process::raw(
                        cwd,
                        &["for-each-ref", &format!("--format={FALLBACK}"), "refs/tags"],
                        scope,
                    )
                    .await
                }
            }
        },
        process::text(cwd, &["remote"], scope)
    );
    let refs = refs?;
    let remotes = remotes?;
    let outcomes =
        futures::future::join_all(remotes.split('\n').filter(|name| !name.is_empty()).map(
            |name| async move {
                (
                    name,
                    Box::pin(process::run_bounded(
                        cwd,
                        &["ls-remote", "--tags", "--refs", name],
                        scope,
                    ))
                    .await,
                )
            },
        ))
        .await;
    scope.check()?;
    let mut published: IndexMap<String, IndexSet<String>> = IndexMap::new();
    let mut checks = Vec::new();
    for (remote, outcome) in outcomes {
        match outcome {
            Ok(output) => {
                for line in output.split('\n') {
                    // Match the source's /\s+/ split, including its initial
                    // empty field when a diagnostic begins with whitespace.
                    let leading = line.chars().next().is_some_and(cantrip_wire::text::whitespace);
                    let mut fields = line.split(cantrip_wire::text::whitespace).filter(|s| !s.is_empty());
                    if !leading { fields.next(); }
                    if let Some(name) = fields.next().and_then(|s| s.strip_prefix("refs/tags/")) {
                        published.entry(name.to_owned()).or_default().insert(remote.to_owned());
                    }
                }
                checks.push(json!({"remote":remote,"available":true,"error":Value::Null}));
            }
            Err(error) => checks.push(json!({"remote":remote,"available":false,"error":slice(&error_message(&error),1_000)})),
        }
    }
    let mut tags = Vec::new();
    for record in refs.split('\u{1e}') {
        let record = record
            .strip_prefix('\n')
            .unwrap_or(record)
            .trim_end_matches(cantrip_wire::text::whitespace);
        if record.is_empty() {
            continue;
        }
        let fields = record.split('\0').collect::<Vec<_>>();
        let f = |index| fields.get(index).copied().unwrap_or("");
        if f(0).is_empty() || f(1).is_empty() || f(2).is_empty() {
            continue;
        }
        let annotated = f(2) == "tag";
        let target = if annotated { f(4) } else { f(2) };
        let mut published = published
            .get(f(0))
            .map(|s| s.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        published.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        let signature = if annotated {
            signatures::details(
                fields.get(8).copied().unwrap_or("N"),
                f(9),
                f(10),
                f(11),
                f(12),
                "",
            )
        } else {
            signatures::details("N", "", "", "", "", "")
        };
        tags.push(json!({
            "name": f(0), "hash": f(1),
            "targetHash": if annotated && !f(3).is_empty() { f(3) } else { f(1) },
            "targetType": if ["commit", "tree", "blob", "tag"].contains(&target) { target } else { "other" },
            "annotated": annotated, "subject": f(5),
            "taggerName": (!f(6).is_empty()).then_some(f(6)),
            "createdAt": (!f(7).is_empty()).then_some(f(7)),
            "signature": signature, "publishedRemotes": published
        }));
    }
    let collator = status::collator()?;
    let empty = JsString::from("");
    tags.sort_by(|a, b| {
        collator
            .compare_utf16_icu4c(
                b["createdAt"].as_js_string().unwrap_or(&empty).units(),
                a["createdAt"].as_js_string().unwrap_or(&empty).units(),
            )
            .then_with(|| {
                collator.compare_utf16_icu4c(
                    a["name"].as_js_string().unwrap().units(),
                    b["name"].as_js_string().unwrap().units(),
                )
            })
    });
    let truncated = tags.len() > 10_000;
    tags.truncate(10_000);
    // Drain accepted verifiers on stop so each collector can kill and reap its
    // owned group. Returning on the first error would drop the other futures.
    let mut verified = futures::stream::iter(tags.into_iter().enumerate())
        .map(|(index, mut tag)| async move {
            verify(cwd, &mut tag, scope).await?;
            Ok::<_, anyhow::Error>((index, tag))
        })
        .buffer_unordered(4)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>>>()?;
    verified.sort_unstable_by_key(|(index, _)| *index);
    let tags = verified.into_iter().map(|(_, tag)| tag).collect::<Vec<_>>();
    checked(
        "gitTagListSchema",
        &json!({"tags":tags,"truncated":truncated,"remoteChecks":checks,"generatedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}),
    )
}
pub async fn detail(cwd: &Path, name: &JsString, scope: &Scope) -> Result<Value> {
    let reference = format!("refs/tags/{}", name.lossy());
    process::run(cwd, &["check-ref-format", &reference], scope).await?;
    let inventory = list(cwd, scope).await?;
    let mut tag = inventory["tags"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tag| tag["name"].as_js_string() == Some(name))
        .cloned()
        .ok_or_else(|| failure("Tag {} does not exist.", &[name]))?;
    let message: JsString = if tag["annotated"] == true {
        process::raw(
            cwd,
            &[
                "for-each-ref",
                "--format=%(contents:subject)%0a%0a%(contents:body)",
                &reference,
            ],
            scope,
        )
        .await?
        .into()
    } else {
        "".into()
    };
    tag["message"] = Value::String(slice(&message, 1_000_000));
    tag["messageTruncated"] = json!(message.len() > 1_000_000);
    checked("gitTagDetailSchema", &tag)
}
pub async fn preview(cwd: &Path, action: &Value, scope: &Scope) -> Result<Value> {
    let inventory = list(cwd, scope).await?;
    let name = action["name"].as_js_string().unwrap();
    let tag = inventory["tags"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tag| tag["name"].as_js_string() == Some(name))
        .cloned()
        .unwrap_or(Value::Null);
    let remotes = remotes::list(cwd, scope).await?;
    let require_remote = |remote: &JsString| -> Result<()> {
        if !remotes["remotes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|known| known["name"].as_js_string() == Some(remote))
        {
            return Err(failure("Git remote {} does not exist.", &[remote]));
        }
        Ok(())
    };
    process::run(
        cwd,
        &["check-ref-format", &format!("refs/tags/{}", name.lossy())],
        scope,
    )
    .await?;
    let kind = action["type"].as_str().unwrap();
    let summary;
    let mut warnings: Vec<JsString> = Vec::new();
    match kind {
        "create" => {
            if !tag.is_null() {
                return Err(failure("Tag {} already exists.", &[name]));
            }
            let target = action["target"].as_js_string();
            if target.is_none()
                && process::run(cwd, &["rev-parse", "--verify", "HEAD"], scope)
                    .await
                    .is_err()
            {
                scope.check()?;
                bail!("An unborn repository needs an existing tag target.");
            }
            if let Some(target) = target {
                process::run(
                    cwd,
                    &[
                        "rev-parse",
                        "--verify",
                        "--end-of-options",
                        &format!("{}^{{object}}", target.lossy()),
                    ],
                    scope,
                )
                .await?;
            }
            let annotation = JsString::from(if action["annotated"] == true {
                "annotated"
            } else {
                "lightweight"
            });
            let suffix = target
                .map(|target| render(" at {}", &[target]))
                .unwrap_or_else(|| " at HEAD".into());
            summary = render("Create {} tag {}{}.", &[&annotation, name, &suffix]);
        }
        "push" => {
            if tag.is_null() {
                return Err(failure("Tag {} does not exist.", &[name]));
            }
            let remote = action["remote"].as_js_string().unwrap();
            require_remote(remote)?;
            if tag["publishedRemotes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value.as_js_string() == Some(remote))
            {
                warnings.push(render(
                    "{} already advertises this tag. Git will refuse a conflicting replacement.",
                    &[remote],
                ));
            }
            summary = render("Push tag {} to {}.", &[name, remote]);
        }
        "deleteLocal" => {
            if tag.is_null() {
                return Err(failure("Tag {} does not exist.", &[name]));
            }
            summary = render("Delete local tag {}.", &[name]);
            let published = tag["publishedRemotes"].as_array().unwrap();
            if !published.is_empty() {
                warnings.push(render(
                    "The tag remains published on {}.",
                    &[&published
                        .iter()
                        .map(|v| v.as_str().unwrap())
                        .collect::<Vec<_>>()
                        .join(", ")
                        .into()],
                ));
            }
        }
        _ => {
            if tag.is_null() {
                return Err(failure("Tag {} does not exist locally.", &[name]));
            }
            let remote = action["remote"].as_js_string().unwrap();
            require_remote(remote)?;
            let check = inventory["remoteChecks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|check| check["remote"].as_js_string() == Some(remote));
            if check.is_none_or(|check| check["available"] != true) {
                let error = check
                    .and_then(|check| check["error"].as_js_string())
                    .cloned()
                    .unwrap_or_else(|| "remote unavailable".into());
                return Err(failure("Cannot verify tags on {}: {}", &[remote, &error]));
            }
            if !tag["publishedRemotes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value.as_js_string() == Some(remote))
            {
                return Err(failure("Tag {} is not published on {}.", &[name, remote]));
            }
            summary = render("Delete tag {} from remote {}.", &[name, remote]);
            warnings.push("This removes the tag for every collaborator using this remote.".into());
        }
    }
    let tags = inventory["tags"].as_array().unwrap().iter().map(|tag|json!({"name":tag["name"],"hash":tag["hash"],"publishedRemotes":tag["publishedRemotes"]})).collect::<Vec<_>>();
    let header = json!({"action":action,"tags":tags,"remoteChecks":inventory["remoteChecks"],"workspace":review::workspace(cwd,scope).await?}).stringify();
    checked(
        "gitTagActionPreviewSchema",
        &json!({"action":action,"token":review::digest(&[header.as_bytes()]),"destructive":kind=="deleteLocal"||kind=="deleteRemote","summary":summary,"warnings":warnings,"tag":tag}),
    )
}
pub async fn apply(cwd: &Path, action: &Value, token: &JsString, scope: &Scope) -> Result<Value> {
    if preview(cwd, action, scope).await?["token"].as_js_string() != Some(token) {
        bail!(
            "The tags, remotes, or worktree changed after this preview. Review the action again."
        );
    }
    let kind = action["type"].as_str().unwrap();
    let name = action["name"].as_js_string().unwrap().lossy();
    let target = action["target"].as_js_string().map(JsString::lossy);
    let remote = action["remote"].as_js_string().map(JsString::lossy);
    let message = action["message"].as_js_string().map(JsString::lossy);
    let mut args = match kind {
        "create" if action["annotated"] == true => {
            vec!["tag", "-a", &name, "-m", message.as_deref().unwrap()]
        }
        "create" => vec!["tag", &name],
        "push" => vec!["push", remote.as_deref().unwrap()],
        "deleteLocal" => vec!["tag", "-d", &name],
        _ => vec!["push", remote.as_deref().unwrap()],
    };
    let reference = if kind == "push" {
        format!("refs/tags/{name}:refs/tags/{name}")
    } else {
        format!(":refs/tags/{name}")
    };
    if kind == "create" {
        if let Some(target) = target.as_deref() {
            args.push(target);
        }
    } else if kind == "push" || kind == "deleteRemote" {
        args.push(&reference);
    }
    let output = if kind == "push" || kind == "deleteRemote" {
        process::run_bounded(cwd, &args, scope).await?
    } else {
        process::run(cwd, &args, scope).await?
    };
    checked(
        "gitTagMutationResultSchema",
        &json!({"output":output,"status":status::status(cwd,scope).await?,"tags":list(cwd,scope).await?}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_inventory_drains_all_owned_verifier_groups() {
        use std::{os::unix::fs::PermissionsExt, time::Duration};
        let root = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(root.path())
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_owned()
        };
        git(&["init", "-b", "main"]);
        git(&["config", "core.hooksPath", "/dev/null"]);
        git(&[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "Base",
        ]);
        let object = root.path().join("tag-object");
        std::fs::write(&object, format!("object {}\ntype commit\ntag fixture\ntagger Fixture <fixture@example.invalid> 1794873600 +0000\n\nFixture\n\n-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n", git(&["rev-parse", "HEAD"]))).unwrap();
        let hash = git(&["hash-object", "-t", "tag", "-w", object.to_str().unwrap()]);
        for index in 0..4 {
            git(&["update-ref", &format!("refs/tags/fixture-{index}"), &hash]);
        }
        let program = root.path().join("owned-verifier");
        std::fs::write(
            &program,
            "#!/bin/sh\nprintf '%s\\n' \"$$\" >> owned-verifier-pids\nexec /bin/sleep 30\n",
        )
        .unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        git(&["config", "gpg.format", "openpgp"]);
        git(&["config", "gpg.program", program.to_str().unwrap()]);
        let (stop, receiver) = tokio::sync::watch::channel(false);
        let scope = Scope::with_stop(receiver);
        let cwd = root.path().to_owned();
        let task = tokio::spawn(async move { list(&cwd, &scope).await });
        let started = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let pids = tokio::fs::read_to_string(root.path().join("owned-verifier-pids"))
                    .await
                    .unwrap_or_default()
                    .lines()
                    .filter_map(|s| s.parse::<i32>().ok())
                    .collect::<Vec<_>>();
                if pids.len() == 4 {
                    break pids;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        // Stop and join even when fixture startup fails, before asserting it.
        stop.send_replace(true);
        let result = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err());
        let pids = started.expect("four actual Git verifier children started");
        tokio::time::timeout(Duration::from_secs(5), async {
            while pids.iter().any(|pid| unsafe { libc::kill(*pid, 0) } == 0) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("all owned verifier groups terminated");
    }

    #[test]
    fn verifier_status_is_anchored_and_classified_before_display_truncation() {
        let signature = signatures::details("E", "", "", "", "-----BEGIN PGP SIGNATURE-----", "");
        for (success, output, status, verification) in [
            (
                true,
                "[GNUPG:] GOODSIG 123 QA\n[GNUPG:] TRUST_FULLY 0 pgp",
                "valid",
                "available",
            ),
            (
                true,
                "[GNUPG:] TRUST_UNDEFINED 0 pgp",
                "valid-unknown",
                "available",
            ),
            (
                true,
                "[GNUPG:] TRUST_NEVER 0 pgp",
                "valid-unknown",
                "available",
            ),
            (false, "[GNUPG:] BADSIG 123 QA", "invalid", "available"),
            (false, "[GNUPG:] EXPSIG 123 QA", "expired", "available"),
            (true, "[GNUPG:] EXPKEYSIG 123 QA", "expired", "available"),
            (true, "[GNUPG:] REVKEYSIG 123 QA", "revoked", "available"),
            (
                false,
                "[GNUPG:] ERRSIG 123\n[GNUPG:] NO_PUBKEY 123",
                "unverifiable",
                "missing-key",
            ),
            (
                false,
                "Verifier failed unexpectedly",
                "unverifiable",
                "error",
            ),
            (
                true,
                "[GNUPG:] GOODSIG 123 QA TRUST_NEVER\n[GNUPG:] TRUST_FULLY 0 pgp",
                "valid",
                "available",
            ),
        ] {
            let result = verification_result(&signature, success, &output.into());
            assert_eq!(result["status"].as_str(), Some(status));
            assert_eq!(result["verification"].as_str(), Some(verification));
        }
        let output = format!("{}[GNUPG:] BADSIG 123 QA", "Warning\n".repeat(2_000));
        let result = verification_result(&signature, false, &output.into());
        assert_eq!(result["status"].as_str(), Some("invalid"));
        assert_eq!(
            result["verificationMessage"].as_js_string().unwrap().len(),
            10_000
        );
    }
}
