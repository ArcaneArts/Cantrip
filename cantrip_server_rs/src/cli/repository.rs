use super::context::Reader;
use crate::{
    database::{Database, query_error},
    wire::{Value, value::json},
};
use anyhow::{Context, Result, bail};
use futures::{FutureExt, future::BoxFuture};
use std::{
    collections::HashMap,
    sync::{Arc, OnceLock},
};

#[derive(serde::Deserialize)]
struct Query {
    sql: String,
    params: Vec<Value>,
}
fn diagnostic<T>(
    result: Result<T>,
    key: &str,
    owner: &str,
    worker: &Value,
    thread: Option<&Value>,
) -> Result<T> {
    if result.is_ok() {
        return result;
    }
    static QUERIES: OnceLock<HashMap<String, Query>> = OnceLock::new();
    let query = &QUERIES.get_or_init(|| {
        serde_json::from_str(include_str!("../../contracts/cli-context-queries.json"))
            .expect("captured CLI context queries")
    })[key];
    let parameters = query
        .params
        .iter()
        .map(|v| {
            if v == "fixture-owner" {
                json!(owner)
            } else if v == "fixture-worker" {
                worker.clone()
            } else if v == "fixture-thread" {
                thread.cloned().unwrap_or(Value::Null)
            } else {
                v.clone()
            }
        })
        .collect::<Vec<_>>();
    query_error::context(result, &query.sql, &parameters)
}
fn encoded(value: &Value) -> Result<String> {
    Ok(value
        .as_js_string()
        .context("CLI context identity")?
        .lossy()
        .into_owned())
}
pub struct Repository {
    pub database: Arc<Database>,
    pub owner: String,
}
impl Reader for Repository {
    fn chat<'a>(&'a self, id: &'a Value) -> BoxFuture<'a, Result<Option<Value>>> {
        async move {
            crate::chats::Repository::new(self.database.clone())
                .execution_context_for_mcp(&self.owner, &encoded(id)?, id)
                .await
        }
        .boxed()
    }
    fn thread<'a>(
        &'a self,
        worker: &'a Value,
        thread: &'a Value,
    ) -> BoxFuture<'a, Result<Vec<Value>>> {
        async move {
            let rows=diagnostic(self.database.query("SELECT r.chat_id FROM chat_runtime_sessions r INNER JOIN chats c ON c.id=r.chat_id WHERE c.owner_id=$1 AND r.worker_id=$2 AND r.codex_thread_id=$3 AND c.archived_at IS NULL",&[&self.owner,&encoded(worker)?,&encoded(thread)?]).await,"thread",&self.owner,worker,Some(thread))?;
            let mut ids=Vec::new();
            for row in rows {let id=row.get::<String>(0)?;if !ids.contains(&id){ids.push(id);}}
            let repository=crate::chats::Repository::new(self.database.clone());
            let raw_ids=ids.iter().map(|id|json!(id)).collect::<Vec<_>>();
            let contexts=futures::future::try_join_all(ids.iter().zip(&raw_ids).map(|(id,raw)|repository.execution_context_for_mcp(&self.owner,id,raw))).await?;
            Ok(contexts.into_iter().flatten().filter(|c|c["workerId"]==*worker && c["threadId"]==*thread).collect())
        }.boxed()
    }
    fn terminal<'a>(&'a self, id: &'a Value) -> BoxFuture<'a, Result<Option<Value>>> {
        async move {
            crate::terminals::Repository::new(self.database.clone())
                .context_for_cli(&self.owner, id)
                .await
        }
        .boxed()
    }
    fn roots<'a>(&'a self, worker: &'a Value) -> BoxFuture<'a, Result<Vec<Value>>> {
        async move {
            let rows=diagnostic(self.database.query("SELECT p.id,w.root_kind,s.absolute_path,w.worker_id,w.id,w.absolute_path FROM project_worktrees w INNER JOIN project_sources s ON s.id=w.project_source_id INNER JOIN projects p ON p.id=s.project_id AND p.owner_id=$1 WHERE w.worker_id=$2 AND w.lifecycle_state='ready' AND s.removed_at IS NULL ORDER BY w.created_at ASC LIMIT 128",&[&self.owner,&encoded(worker)?]).await,"roots",&self.owner,worker,None)?;
            rows.iter().map(|row|{
                let Some(path)=row.get::<Option<String>>(5)? else {bail!("This checkout requires a CantripOS execution target.")};
                Ok(json!({"projectId":row.get::<String>(0)?,"rootKind":row.get::<String>(1)?,"sourcePath":row.get::<Option<String>>(2)?,"workerId":row.get::<String>(3)?,"worktreeId":row.get::<String>(4)?,"worktreePath":path}))
            }).collect()
        }.boxed()
    }
}
