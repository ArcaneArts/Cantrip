//! Actual command/prompt collaborators bound to one owning transaction.
//! No operation here opens an independent database connection.
use super::{admit, attachments, context, control, managed_queue, queued_prompt, receipt};
use crate::{
    chats::execution_lanes::savepoint,
    database::{Executor, Transaction},
    wire::Value,
};
use anyhow::Result;
use futures::FutureExt;
#[derive(Clone, Copy)]
pub struct TransactionRepository<'a, 'db> {
    tx: &'a Transaction<'db>,
}
impl<'a, 'db> TransactionRepository<'a, 'db> {
    pub fn new(tx: &'a Transaction<'db>) -> Self {
        Self { tx }
    }
    pub fn executor(&self) -> Executor<'a, 'db> {
        Executor::Transaction(self.tx)
    }
    pub fn interactions(&self) -> crate::agent_interactions::Repository<'a, 'db> {
        crate::agent_interactions::Repository::new(self.executor())
    }
    pub async fn upsert_encrypted_message(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: Option<&Value>,
    ) -> Result<Option<Value>> {
        let (owner, chat, input, attribution) = (
            owner.to_owned(),
            chat.to_owned(),
            input.clone(),
            attribution.cloned(),
        );
        savepoint(self.tx, |tx| {
            Box::pin(async move {
                crate::chats::message_writes::write_in_transaction(
                    tx,
                    &owner,
                    &chat,
                    &input,
                    attribution.as_ref(),
                    true,
                )
                .boxed()
                .await
            })
        })
        .await
    }
    pub async fn upsert_task_message(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attribution: Option<&Value>,
    ) -> Result<Option<Value>> {
        crate::chats::message_writes::upsert_task_with(
            self.executor(),
            owner,
            chat,
            input,
            attribution,
        )
        .boxed()
        .await
    }
    pub async fn update_encrypted_plan(&self, chat: &str, input: &Value) -> Result<()> {
        let parsed = super::settings_persistence::parse("chatPlanOpaqueStateSchema", input)?;
        self.tx.query("UPDATE chats SET protected_plan=$1::text::jsonb,has_pending_plan_question=$2,updated_at=$3 WHERE id=$4",&[&parsed.stringify(),&parsed["classification"]["hasQuestion"].as_bool().unwrap(),&crate::auth::now(),&chat]).await?;
        Ok(())
    }
    pub async fn execution_context(&self, owner: &str, chat: &str) -> Result<Option<Value>> {
        context::execution(self.tx, owner, chat).boxed().await
    }
    pub async fn admit(&self, owner: &str, input: &Value, options: &Value) -> Result<Value> {
        let (owner, input, options) = (owner.to_owned(), input.clone(), options.clone());
        savepoint(self.tx, |tx| {
            Box::pin(async move { admit::admit(tx, &owner, &input, &options).boxed().await })
        })
        .await
    }
    pub async fn control_context(&self, owner: &str, chat: &str) -> Result<Value> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        savepoint(self.tx, |tx| {
            Box::pin(async move { control::control_context(tx, &owner, &chat).boxed().await })
        })
        .await
    }
    pub async fn resume_autonomy(&self, owner: &str, chat: &str) -> Result<()> {
        let (owner, chat) = (owner.to_owned(), chat.to_owned());
        savepoint(self.tx, |tx| {
            Box::pin(async move { control::resume(tx, &owner, &chat).boxed().await })
        })
        .await
    }
    pub async fn get(
        &self,
        owner: &str,
        worker: &str,
        id: &str,
        generation: &str,
    ) -> Result<Value> {
        let (owner, worker, id, generation) = (
            owner.to_owned(),
            worker.to_owned(),
            id.to_owned(),
            generation.to_owned(),
        );
        savepoint(self.tx, |tx| {
            Box::pin(async move {
                receipt::from_row(
                    &context::read(Executor::Transaction(tx), &owner, &worker, &id, &generation)
                        .await?,
                )
            })
        })
        .await
    }
    pub async fn encrypted_prompts(&self, owner: &str, chat: &str) -> Result<Vec<Value>> {
        queued_prompt::encrypted_list(self.executor(), owner, chat)
            .boxed()
            .await
    }
    pub async fn chat_attachments(
        &self,
        owner: &str,
        chat: &str,
        ids: &Value,
    ) -> Result<Vec<Value>> {
        attachments::get(self.executor(), owner, chat, ids)
            .boxed()
            .await
    }
    pub async fn mutate_queue(&self, owner: &str, input: &Value, options: &Value) -> Result<Value> {
        let (owner, input, options) = (owner.to_owned(), input.clone(), options.clone());
        savepoint(self.tx, |tx| {
            Box::pin(async move {
                managed_queue::mutate_in_transaction(tx, &owner, &input, &options)
                    .boxed()
                    .await
            })
        })
        .await
    }
    pub async fn encrypted_prompt(&self, owner: &str, id: &str) -> Result<Option<Value>> {
        queued_prompt::encrypted_get(self.executor(), owner, id)
            .boxed()
            .await
    }
    /// Enqueue a GUI add using the surrounding delivery transaction throughout.
    pub(crate) async fn add_gui_prompt(
        &self,
        owner: &str,
        context: &Value,
        prompt: &Value,
        options: &Value,
    ) -> Result<Value> {
        let chat = super::admit::text(&context["chatId"])?;
        let (snapshot_owner, snapshot_chat) = (owner.to_owned(), chat.clone());
        let state = savepoint(self.tx, |tx| {
            Box::pin(async move {
                managed_queue::owned_snapshot(tx, &snapshot_owner, &snapshot_chat)
                    .boxed()
                    .await
            })
        })
        .await?;
        let control = self.control_context(owner, &chat).await?;
        let mutation = crate::wire::value::json!({"kind":"add","prompt":prompt,"attachments":Vec::<Value>::new()});
        let input = super::runtime::gui_queue::prepare_input(
            context, &mutation, options, &state, &control, prompt,
        )?;
        let mut expected = Value::object([] as [(&str, Value); 0]);
        if let Some(revision) = context.get("managedInputRevision") {
            expected["expectedInputRevision"] = revision.clone();
        }
        let result = self.mutate_queue(owner, &input, &expected).await?;
        super::runtime::gui_queue::reject(&result)?;
        Ok(result)
    }
    pub async fn create_prompt(
        &self,
        owner: &str,
        chat: &str,
        input: &Value,
        attachments: &Value,
    ) -> Result<Option<Value>> {
        queued_prompt::create_with(self.executor(), owner, chat, input, attachments)
            .boxed()
            .await
    }
    pub async fn replace_prompt(
        &self,
        owner: &str,
        id: &Value,
        input: &Value,
        attachments: &Value,
    ) -> Result<Option<Value>> {
        queued_prompt::replace_with(self.executor(), owner, id, input, attachments)
            .boxed()
            .await
    }
}
