use super::{Authorized, Inner};
use crate::{
    encryption::Service,
    history::council::{Document, Index, Link, Projection, bounded_text},
};
use anyhow::{Context, Result, ensure};
use cantrip_history::canonical::open_message;
use cantrip_protocol::{mcp_host, response::response_error};
use cantrip_wire::{Value, value::json};

const SEARCH: &str = "council.history.search";
const READ: &str = "council.history.read";
const LAST_SEQUENCE: i64 = 9_007_199_254_740_991;

impl Inner {
    pub(super) async fn council_history(
        &self,
        authorization: &Authorized,
        call: &Value,
        operation: &str,
    ) -> Result<Value> {
        let name = if operation == SEARCH {
            "council_history_search"
        } else {
            "council_history_read"
        };
        let input = mcp_host::parse(&format!("mcpStdioInput/{name}"), call.get("arguments"))
            .map_err(response_error)?;
        let source = Source {
            inner: self,
            authorization,
            encryption: self
                .encryption
                .as_deref()
                .context("Council history encryption is unavailable")?,
        };
        let agent = authorization.active.binding["chatId"]
            .as_js_string()
            .context("Council history identity")?;
        let link = Link(agent.as_str().context("Council history agent ID")?);
        let data = if operation == SEARCH {
            let slot = self
                .council_history
                .for_agent(&authorization.identity, agent);
            let mut cached = slot.lock().await;
            source.search(&mut cached, &link, &input).await?
        } else {
            source.read(&link, input).await?
        };
        let summary = if operation == SEARCH {
            if data["coverage"] == "partial" {
                "Searched the available Council history. Some retained material could not be indexed."
            } else {
                "Searched the Council conversation."
            }
        } else if data["availability"] == "available" {
            "Loaded the requested Council message and nearby evidence."
        } else {
            "The requested Council message is unavailable."
        };
        mcp_host::parse(
            &format!("mcpStdioOutput/{name}"),
            Some(&json!({"summary":summary,"data":data})),
        )
        .map_err(response_error)
    }
}

struct Source<'a> {
    inner: &'a Inner,
    authorization: &'a Authorized,
    encryption: &'a Service,
}

impl Source<'_> {
    async fn fetch(&self, operation: &str, arguments: Value, schema: &str) -> Result<Value> {
        let response = self
            .inner
            .relay_project(
                self.authorization,
                json!({"operation":operation,"arguments":arguments}),
                &uuid::Uuid::new_v4().to_string(),
            )
            .await?;
        crate::http::checked(schema, &response["data"])
    }

    fn project(&self, id: &str, message: &Value) -> Projection {
        let opened = if message.is_null() {
            Ok(None)
        } else {
            self.document(message)
        };
        let unavailable = match &opened {
            Ok(document) => document.as_ref().is_some_and(|doc| doc.truncated),
            Err(_) => true,
        };
        Projection {
            id: id.into(),
            document: opened.ok().flatten(),
            unavailable,
        }
    }

    fn document(&self, message: &Value) -> Result<Option<Document>> {
        let revision = message["protectedContent"]["keyRevision"]
            .as_u64()
            .context("Council history key revision")?;
        let grant = self
            .encryption
            .bound_component("chat-content", Some(revision))?;
        ensure!(
            grant.owner_id == self.authorization.identity.0
                && grant.server_id.as_js_string() == Some(&self.authorization.identity.1),
            "Council history worker identity changed."
        );
        let content = open_message(&grant.component.key, &json!(grant.owner_id), message)?;
        Document::open(message, &content)
    }

    async fn head(&self) -> Result<(i64, i64)> {
        let head = self
            .fetch(SEARCH, json!({"kind":"head"}), "councilHistoryHeadSchema")
            .await?;
        Ok((
            number(&head, "revision")?,
            number(&head, "throughSequence")?,
        ))
    }

    async fn search(
        &self,
        cached: &mut Option<Index>,
        link: &Link<'_>,
        input: &Value,
    ) -> Result<Value> {
        for _ in 0..3 {
            let (revision, through) = self.head().await?;
            if cached
                .as_ref()
                .is_none_or(|index| index.revision > revision)
            {
                *cached = Some(Index::new(revision)?);
            }
            let index = cached.as_mut().context("Council history index")?;
            self.append(index, through).await?;
            self.update(index, revision).await?;
            if self.head().await?.0 != revision {
                continue;
            }
            let unavailable = index.unavailable();
            let matches = index.search(
                link,
                string(input, "query")?,
                input["mode"] == "literal",
                number(input, "limit")? as usize,
            )?;
            return Ok(
                json!({"coverage":if unavailable == 0 {"complete"} else {"partial"},
                "indexedMessages":index.documents,"unavailableMessages":unavailable,"matches":matches}),
            );
        }
        anyhow::bail!("Council history changed during search. Please try again.")
    }

    async fn append(&self, index: &mut Index, through: i64) -> Result<()> {
        while index.through_sequence < through {
            let result = self.fetch(SEARCH,json!({"kind":"page","afterSequence":index.through_sequence,"throughSequence":through}),
                "councilHistorySourcePageSchema").await?;
            let records = result["records"]
                .as_array()
                .context("Council history page")?;
            let Some(last) = records.last() else { break };
            let sequence = number(last, "sequence")?;
            ensure!(
                sequence > index.through_sequence && sequence <= through,
                "Council history cursor failed to advance."
            );
            let projected = records
                .iter()
                .map(|row| Ok(self.project(string(row, "id")?, row)))
                .collect::<Result<Vec<_>>>()?;
            index.apply(&projected, false)?;
            index.through_sequence = sequence;
        }
        Ok(())
    }

    async fn update(&self, index: &mut Index, revision: i64) -> Result<()> {
        if index.revision == revision {
            return Ok(());
        }
        let mut cursor = (index.revision, LAST_SEQUENCE);
        loop {
            let result = self
                .fetch(
                    SEARCH,
                    json!({"kind":"changes","afterRevision":cursor.0,"afterSequence":cursor.1,
                "throughRevision":revision}),
                    "councilHistorySourceChangesSchema",
                )
                .await?;
            let changes = result["changes"]
                .as_array()
                .context("Council history revisions")?;
            let Some(last) = changes.last() else { break };
            let next = (number(last, "revision")?, number(last, "sequence")?);
            ensure!(
                next > cursor && next.0 <= revision,
                "Council history revision cursor failed to advance."
            );
            let projected = changes
                .iter()
                .map(|change| Ok(self.project(string(change, "messageId")?, &change["record"])))
                .collect::<Result<Vec<_>>>()?;
            index.apply(&projected, true)?;
            cursor = next;
        }
        index.revision = revision;
        Ok(())
    }

    async fn read(&self, link: &Link<'_>, input: Value) -> Result<Value> {
        let id = string(&input, "messageId")?.to_owned();
        let data = self
            .fetch(READ, input, "councilHistorySourceRangeSchema")
            .await?;
        let mut messages = Vec::new();
        let mut available = false;
        for message in data["records"]
            .as_array()
            .context("Council history result")?
        {
            if let Ok(Some(document)) = self.document(message) {
                available |= document.id == id;
                let mut evidence = link.evidence(
                    &document.id,
                    document.sequence,
                    &document.role,
                    document.source,
                    &document.created_at,
                );
                evidence["text"] = json!(bounded_text(&document.text, 1_200));
                evidence["attachments"] = json!(document.attachments);
                messages.push(evidence);
            }
        }
        Ok(
            json!({"availability":if available {"available"} else {"unavailable"},"messages":messages}),
        )
    }
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .with_context(|| format!("Council history field {key}"))
}

fn number(value: &Value, key: &str) -> Result<i64> {
    value[key]
        .as_i64()
        .with_context(|| format!("Council history field {key}"))
}
