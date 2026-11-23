use super::super::{Client, api, common::*};
use crate::{error::WireError, filesystem::Scope};
use anyhow::Result;
use cantrip_crypto::checked;
use cantrip_wire::{Value, value::json};
async fn has(command: &Value, sha: &Value, scope: &Scope) -> bool {
    let revision = join(
        &[sha.as_js_string().unwrap().clone(), "^{commit}".into()],
        "",
    );
    git(
        command,
        &["rev-parse".into(), "--verify".into(), revision],
        scope,
    )
    .await
    .is_ok_and(|value| !value.trim().is_empty())
}
impl Client {
    pub(in crate::github) async fn actions_checkout(
        &self,
        command: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        verify(command, scope).await?;
        let repository = api::repository_path(command["repository"].as_js_string().unwrap())?;
        let run = super::parse::run(
            &self
                .api(
                    &format!(
                        "{repository}/actions/runs/{}",
                        api::text(Some(&command["runId"]))?.lossy()
                    ),
                    &[],
                    scope,
                )
                .await?,
        )?;
        let remote = remote(command, scope).await?.ok_or_else(|| {
            WireError(join(
                &[
                    "No Git remote in this project points to ".into(),
                    command["repository"].as_js_string().unwrap().clone(),
                    ". Add the GitHub repository as a remote before creating a run worktree."
                        .into(),
                ],
                "",
            ))
        })?;
        if !has(command, &run["headSha"], scope).await {
            let mut refs = vec![run["headSha"].as_js_string().unwrap().clone()];
            if !run["pullRequestNumber"].is_null() {
                refs.push(
                    format!(
                        "refs/pull/{}/head",
                        api::text(Some(&run["pullRequestNumber"]))?.lossy()
                    )
                    .into(),
                );
            }
            if !run["headBranch"].is_null() {
                refs.push(api::prefix(
                    "refs/heads/",
                    run["headBranch"].as_js_string().unwrap(),
                ));
            }
            let mut seen = std::collections::HashSet::new();
            let mut last = None;
            for reference in refs {
                if !seen.insert(reference.clone()) {
                    continue;
                }
                match git(
                    command,
                    &[
                        "fetch".into(),
                        "--no-tags".into(),
                        "--".into(),
                        remote.clone(),
                        reference,
                    ],
                    scope,
                )
                .await
                {
                    Ok(_) => {
                        if has(command, &run["headSha"], scope).await {
                            break;
                        }
                    }
                    Err(error) => {
                        last = Some(crate::error::message(&error));
                    }
                }
            }
            if !has(command, &run["headSha"], scope).await {
                return Err(WireError(join(
                    &[
                        format!(
                            "Git could not fetch the exact workflow run commit {}: ",
                            &run["headSha"].as_str().unwrap()[..12]
                        )
                        .into(),
                        last.unwrap_or_else(|| {
                            "the commit is unavailable from this repository".into()
                        }),
                    ],
                    "",
                ))
                .into());
            }
        }
        let number = api::text(Some(&run["runNumber"]))?.lossy().into_owned();
        let title = slug(run["displayTitle"].as_js_string().unwrap(), 40);
        let title = if title.is_empty() {
            run["name"].as_js_string().unwrap().clone()
        } else {
            title.into()
        };
        let name = crop(&api::prefix(&format!("Actions #{number} "), &title), 200);
        checked(
            "githubActionsRunCheckoutPreparedSchema",
            &json!({"run":run,"branch":format!("cantrip/actions/{number}-{}",&run["headSha"].as_str().unwrap()[..8]),"name":name,"headSha":run["headSha"],"remote":remote}),
        )
    }
}
