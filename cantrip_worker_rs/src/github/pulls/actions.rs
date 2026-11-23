//! Review mutations retain Source ordering and refresh the complete detail only
//! after success. Accepted remote effects are never retried after a later error.
use super::{Client, api, helpers, parse, pull_path, verify};
use crate::filesystem::Scope;
use anyhow::{Result, bail};
use cantrip_wire::{Value, value::json};

impl Client {
    pub(in crate::github) async fn mutate_pull(
        &self,
        command: &Value,
        scope: &Scope,
    ) -> Result<Value> {
        let action = match command["type"].as_str().unwrap() {
            "github.pull-request.comment" => json!({"type":"comment","body":command["body"]}),
            "github.pull-request.review.submit" => {
                json!({"type":"submit-review","review":command["review"]})
            }
            "github.pull-request.review.comment" => {
                json!({"type":"inline-comment","comment":command["comment"]})
            }
            "github.pull-request.review.reply" => {
                json!({"type":"reply","commentId":command["commentId"],"body":command["body"]})
            }
            _ => command["action"].clone(),
        };
        verify(command, scope).await?;
        let repository = api::repository_path(command["repository"].as_js_string().unwrap())?;
        let number = api::text(Some(&command["number"]))?;
        let path = pull_path(command)?;
        match action["type"].as_str().unwrap() {
            "comment" => {
                self.api(
                    &format!("{repository}/issues/{}/comments", number.lossy()),
                    &helpers::form("POST", &[("body", &action["body"])])?,
                    scope,
                )
                .await?;
            }
            "reply" => {
                let id = api::text(Some(&action["commentId"]))?;
                self.api(
                    &format!("{path}/comments/{}/replies", id.lossy()),
                    &helpers::form("POST", &[("body", &action["body"])])?,
                    scope,
                )
                .await?;
            }
            "submit-review" => {
                let review = &action["review"];
                let event = json!(match review["event"].as_str().unwrap() {
                    "approve" => "APPROVE",
                    "request-changes" => "REQUEST_CHANGES",
                    _ => "COMMENT",
                });
                let context = self.pull_context(command, scope).await?;
                if !context["pendingReview"].is_null() {
                    let body = if review["body"].as_js_string().unwrap().is_empty() {
                        Value::Null
                    } else {
                        review["body"].clone()
                    };
                    self.pull_graphql(
                        include_str!("submit-review.graphql"),
                        &[
                            ("reviewId", &context["pendingReview"]["id"]),
                            ("event", &event),
                            ("body", &body),
                        ],
                        scope,
                    )
                    .await?;
                } else {
                    self.api(
                        &format!("{path}/reviews"),
                        &helpers::form("POST", &[("event", &event), ("body", &review["body"])])?,
                        scope,
                    )
                    .await?;
                }
            }
            "inline-comment" => {
                let pull = parse::summary(&self.api(&path, &[], scope).await?)?;
                let context = self.pull_context(command, scope).await?;
                let mut id = context["pendingReview"]["id"].clone();
                if !cantrip_wire::coercion::truthy(Some(&id)) {
                    let created = self
                        .pull_graphql(
                            include_str!("create-review.graphql"),
                            &[
                                ("pullRequestId", &context["nodeId"]),
                                ("head", &pull["headSha"]),
                            ],
                            scope,
                        )
                        .await?;
                    id = created["data"]["addPullRequestReview"]["pullRequestReview"]["id"].clone();
                    if !id.is_string() || id.as_js_string().unwrap().is_empty() {
                        bail!("GitHub did not create a pending review.");
                    }
                }
                let comment = &action["comment"];
                self.pull_graphql(
                    include_str!("add-thread.graphql"),
                    &[
                        ("reviewId", &id),
                        ("body", &comment["body"]),
                        ("path", &comment["path"]),
                        ("line", &comment["line"]),
                        ("side", &comment["side"]),
                        ("startLine", &comment["startLine"]),
                        ("startSide", &comment["startSide"]),
                    ],
                    scope,
                )
                .await?;
            }
            "discard-review" => {
                let context = self.pull_context(command, scope).await?;
                if context["pendingReview"].is_null() {
                    bail!("There is no pending review to discard.");
                }
                self.pull_graphql(
                    include_str!("delete-review.graphql"),
                    &[("reviewId", &context["pendingReview"]["id"])],
                    scope,
                )
                .await?;
            }
            "set-thread-resolved" => {
                let context = self.pull_context(command, scope).await?;
                if !super::array(&context["reviewThreads"])
                    .iter()
                    .any(|thread| thread["id"] == action["threadId"])
                {
                    bail!("The review thread does not belong to this pull request.");
                }
                let document = if action["resolved"] == true {
                    include_str!("resolve-thread.graphql")
                } else {
                    include_str!("unresolve-thread.graphql")
                };
                self.pull_graphql(document, &[("threadId", &action["threadId"])], scope)
                    .await?;
            }
            "set-file-viewed" => {
                let context = self.pull_context(command, scope).await?;
                let document = if action["viewed"] == true {
                    include_str!("mark-viewed.graphql")
                } else {
                    include_str!("unmark-viewed.graphql")
                };
                self.pull_graphql(
                    document,
                    &[
                        ("pullRequestId", &context["nodeId"]),
                        ("path", &action["path"]),
                    ],
                    scope,
                )
                .await?;
            }
            "update-details" => self.update_pull(command, &action["details"], scope).await?,
            _ => unreachable!("validated review action"),
        }
        self.pull_all(command, scope).await
    }
    async fn update_pull(&self, command: &Value, details: &Value, scope: &Scope) -> Result<()> {
        let repository = api::repository_path(command["repository"].as_js_string().unwrap())?;
        let number = api::text(Some(&command["number"]))?;
        let path = pull_path(command)?;
        let current = self.pull_overview(command, scope).await?;
        self.api(
            &path,
            &helpers::form(
                "PATCH",
                &[("title", &details["title"]), ("body", &details["body"])],
            )?,
            scope,
        )
        .await?;
        let next = helpers::strings(&details["labels"]);
        let previous = super::array(&current["labels"])
            .iter()
            .map(|label| label["name"].as_js_string().unwrap().clone())
            .collect::<indexmap::IndexSet<_>>();
        let added = next.difference(&previous).cloned().collect::<Vec<_>>();
        let labels = format!("{repository}/issues/{}/labels", number.lossy());
        if !added.is_empty() {
            self.api(&labels, &helpers::repeated("POST", "labels", added), scope)
                .await?;
        }
        for label in previous.difference(&next) {
            self.api(
                &format!("{labels}/{}", helpers::encode_component(label)?),
                &["--method".into(), "DELETE".into()],
                scope,
            )
            .await?;
        }
        let next = helpers::strings(&details["reviewers"]);
        let previous = helpers::strings(&current["requestedReviewers"]);
        for (method, values) in [
            (
                "POST",
                next.difference(&previous).cloned().collect::<Vec<_>>(),
            ),
            (
                "DELETE",
                previous.difference(&next).cloned().collect::<Vec<_>>(),
            ),
        ] {
            if !values.is_empty() {
                self.api(
                    &format!("{path}/requested_reviewers"),
                    &helpers::repeated(method, "reviewers", values),
                    scope,
                )
                .await?;
            }
        }
        Ok(())
    }
}
