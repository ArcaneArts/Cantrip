use super::{Executor, Repository, Result, Value, conflict, json, parse_response, string};
use anyhow::Context;

#[derive(Clone, Copy)]
pub enum CouncilAutomationMutation {
    Create,
    Update,
}

impl Repository {
    pub async fn mutate_council(
        &self,
        owner: &str,
        source: &str,
        mutation: CouncilAutomationMutation,
        input: Value,
    ) -> Result<Option<(Value, bool)>> {
        let operation = string(&input["operationId"])?;
        let (kind, id, requested_target) = match mutation {
            CouncilAutomationMutation::Create => (
                "create",
                string(&input["routine"]["id"])?,
                Some(string(&input["routine"]["chatId"])?),
            ),
            CouncilAutomationMutation::Update => {
                if input["changes"].get("chatId").is_some()
                    || input["changes"]["content"]
                        .get("protectedCondition")
                        .is_some()
                {
                    return conflict(
                        "A Council routine edit can change its name, prompt, schedule or enabled state.",
                    );
                }
                ("update", string(&input["automationId"])?, None)
            }
        };
        let (owner, source) = (owner.to_owned(), source.to_owned());
        self.database.transaction(move |tx| Box::pin(async move {
            if tx.query(
                "SELECT chat_id FROM council_agents WHERE chat_id=$1 AND owner_id=$2 FOR UPDATE",
                &[&source,&owner],
            ).await?.is_empty() {
                return Ok(None);
            }
            let rows = tx.query(
                "SELECT operation,automation_id,target_chat_id,result::text FROM council_automation_mutations
                 WHERE source_chat_id=$1 AND operation_id=$2::text::uuid",
                &[&source,&operation],
            ).await?;
            if let Some(row) = rows.first() {
                if row.get::<&str>(0)? != kind
                    || row.get::<&str>(1)? != id
                    || requested_target.as_deref().is_some_and(|target| row.get::<&str>(2).ok() != Some(target))
                {
                    return conflict("This routine operation ID already belongs to another action.");
                }
                return Ok(Some((serde_json::from_str(row.get::<&str>(3)?)?, false)));
            }
            let executor = Executor::Transaction(tx);
            let routine = match mutation {
                CouncilAutomationMutation::Create => {
                    Self::create_target(executor, &owner, None, &input["routine"]).await?
                }
                CouncilAutomationMutation::Update => {
                    Self::update_with(executor, &owner, &id, &input["changes"], Some(&input["expectedRevision"])).await?
                }
            };
            let Some(routine) = routine else {
                return Ok(None);
            };
            let target = routine["chatId"].as_str().context("Council routine target")?;
            let receipt = parse_response("councilAutomationMutationReceiptSchema", Some(&json!({
                "operationId":operation,"id":id,"chatId":target,"revision":routine["revision"],
                "enabled":routine["enabled"],"nextRunAt":routine["nextRunAt"],
            })))?;
            tx.query(
                "INSERT INTO council_automation_mutations(source_chat_id,operation_id,operation,automation_id,target_chat_id,result)
                 VALUES($1,$2::text::uuid,$3,$4,$5,$6::text::jsonb)",
                &[&source,&operation,&kind,&id,&target,&receipt.stringify()],
            ).await?;
            Ok(Some((receipt, true)))
        })).await
    }
}
