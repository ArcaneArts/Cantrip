use super::{Link, Requester, Source};
use crate::mcp::bindings::Broker;
use anyhow::{Context, Result, anyhow, ensure};
use cantrip_crypto::{Zeroizing, decrypt_payload, derive_field_key, encrypt_payload};
use cantrip_wire::{Value, parse_json_text, value::json};

impl Broker {
    pub(crate) async fn search_council_history(&self, command: &Value) -> Result<Value> {
        let command = crate::http::checked("councilHistorySearchCommandSchema", command)?;
        let identity = (self.inner.identity)()?;
        let encryption = self
            .inner
            .encryption
            .as_deref()
            .context("Council history encryption is unavailable")?;
        let agent = command["agentId"]
            .as_js_string()
            .context("Council history agent")?;
        let request = command["requestId"]
            .as_str()
            .context("Council history request")?;
        let agent_id = agent.as_str().context("Invalid Council history agent")?;
        let revision = command["protectedQuery"]["keyRevision"]
            .as_u64()
            .context("Council history query key revision")?;
        let grant = encryption.bound_component("chat-content", Some(revision))?;
        ensure!(
            grant.owner_id == identity.0 && grant.server_id.as_js_string() == Some(&identity.1),
            "Council history worker identity changed."
        );
        let associated = |field| {
            json!({"ownerId":identity.0,"component":"chat-content","table":"council_history_exchange",
            "rowId":format!("{agent_id}:{request}"),"field":field,"formatVersion":1,"keyRevision":revision})
        };
        let data = associated("query");
        let key = derive_field_key(&grant.component.key, &data)?;
        let opened = decrypt_payload(&key, &command["protectedQuery"], &data)?;
        let raw = parse_json_text(
            std::str::from_utf8(&opened).context("Invalid Council history query encoding")?,
        )
        .map_err(|_| anyhow!("Invalid Council history query"))?;
        let input = crate::http::checked("councilHistorySearchInputSchema", &raw)?;

        let source = Source {
            inner: &self.inner,
            requester: Requester::App(&command["agentId"]),
            identity: &identity,
            encryption,
        };
        let slot = self.inner.council_history.for_agent(&identity, agent);
        let mut cached = slot.lock().await;
        let result = source.search(&mut cached, &Link(agent_id), &input).await?;
        ensure!(
            (self.inner.identity)()? == identity,
            "Council history worker identity changed."
        );

        let data = associated("result");
        let key = derive_field_key(&grant.component.key, &data)?;
        let bytes = Zeroizing::new(result.stringify().into_bytes());
        crate::http::checked(
            "councilHistorySearchReplySchema",
            &json!({"requestId":request,"protectedResult":encrypt_payload(&key,&bytes,&data)?}),
        )
    }
}
