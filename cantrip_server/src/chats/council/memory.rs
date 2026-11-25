use super::{Repository, RosterError};
use crate::{database::Executor, wire::Value};
use anyhow::Result;

const PROJECTION: &str = "jsonb_build_object('agentId', chat_id, 'revision', memory_revision, 'protectedMemory', protected_memory)::text";

async fn read(executor: Executor<'_, '_>, owner: &str, agent: &str) -> Result<Option<Value>> {
    executor
        .query(
            &format!("SELECT {PROJECTION} FROM council_agents WHERE owner_id=$1 AND chat_id=$2"),
            &[&owner, &agent],
        )
        .await?
        .first()
        .map(crate::chats::catalog::raw)
        .transpose()
}

impl Repository {
    pub(crate) async fn council_memory(&self, owner: &str, agent: &str) -> Result<Value> {
        read(Executor::Database(&self.database), owner, agent)
            .await?
            .ok_or_else(|| RosterError::NotFound.into())
    }

    pub(crate) async fn update_council_memory(
        &self,
        owner: &str,
        agent: &str,
        input: Value,
    ) -> Result<Value> {
        let (owner, agent) = (owner.to_owned(), agent.to_owned());
        self.database.transaction(move |tx| Box::pin(async move {
            let memory = (!input["protectedMemory"].is_null()).then(|| input["protectedMemory"].stringify());
            let revision = input["expectedRevision"].stringify();
            let rows = tx.query(
                &format!("UPDATE council_agents SET protected_memory=$3::text::jsonb, memory_revision=memory_revision+1
                    WHERE owner_id=$1 AND chat_id=$2 AND memory_revision=$4::text::integer RETURNING {PROJECTION}"),
                &[&owner, &agent, &memory, &revision],
            ).await?;
            if let Some(row) = rows.first() {
                return crate::chats::catalog::raw(row);
            }
            if read(Executor::Transaction(tx), &owner, &agent).await?.is_some() {
                Err(RosterError::Conflict.into())
            } else {
                Err(RosterError::NotFound.into())
            }
        })).await
    }
}
