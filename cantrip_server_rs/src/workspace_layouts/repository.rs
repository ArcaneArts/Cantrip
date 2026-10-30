use super::{
    ModelError, apply, import_legacy_files, parse,
    queries::{self, Query},
    strict_equal, values,
};
use crate::{
    database::{Database, Row, Transaction},
    wire::{Value, coercion::truthy, value::json},
};
use anyhow::Result;
use std::sync::Arc;

pub struct Repository {
    database: Arc<Database>,
}
fn command_error(code: &'static str, message: &str) -> anyhow::Error {
    ModelError::command(code, message).into()
}
fn layout(rows: &[Row]) -> Result<Option<Value>> {
    rows.first()
        .map(|row| {
            parse(
                "workspaceOwnershipSchema",
                &row.get::<postgres_types::Json<Value>>(queries::column(
                    "workspaceLayouts",
                    "layout",
                ))?
                .0,
            )
            .map_err(Into::into)
        })
        .transpose()
}
fn placements(layout: &Value) -> Result<()> {
    for window in values(layout, "windows") {
        for pane in values(window, "panes") {
            for tab in values(pane, "tabs") {
                let valid =
                    queries::definition(&tab["resource"]["definitionId"]).is_some_and(|d| {
                        d.id != "project.overview"
                            && d.supported_placements
                                .iter()
                                .any(|p| pane["region"] == p.as_str())
                    });
                if !valid {
                    return Err(command_error(
                        "invalid",
                        "The surface does not support this pane placement.",
                    ));
                }
            }
        }
    }
    Ok(())
}
impl Repository {
    pub fn new(database: Arc<Database>) -> Self {
        Self { database }
    }
    pub async fn seed(
        &self,
        owner: &str,
        project: &str,
        workspace: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let input = parse("workspaceSeedRequestSchema", input)?;
        let mut fields = json!({"owner":owner,"project":project,"workspace":workspace});
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    if Query::new("authority", &fields)?.run(tx).await?.is_empty() {
                        return Ok(None);
                    }
                    let seeded = |value: Value| -> Result<Value> {
                        let value = parse("workspaceOwnershipSchema", &value)?;
                        if value["mainWindowId"] != input["mainWindowId"] {
                            return Err(command_error(
                                "scope",
                                "This workspace already has a different main window.",
                            ));
                        }
                        Ok(value)
                    };
                    if let Some(value) = layout(&Query::new("get", &fields)?.run(tx).await?)? {
                        return seeded(value).map(Some);
                    }
                    let Some(legacy) = super::legacy::get(tx, &fields).await? else {
                        return Ok(None);
                    };
                    let mut request = input.clone();
                    request["workspaceId"] = fields["workspace"].clone();
                    request["legacy"] = legacy;
                    let value = super::seed(&request)?;
                    placements(&value)?;
                    fields["layout"] = value;
                    Query::new("insert", &fields)?.run(tx).await?;
                    let rows = Query::new("get", &fields)?.run(tx).await?;
                    let value = rows
                        .first()
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "Cannot read properties of undefined (reading 'layout')"
                            )
                        })?
                        .get::<postgres_types::Json<Value>>(queries::column(
                            "workspaceLayouts",
                            "layout",
                        ))?
                        .0;
                    seeded(value).map(Some)
                })
            })
            .await
    }
    pub async fn get(&self, owner: &str, project: &str, workspace: &str) -> Result<Option<Value>> {
        let fields = json!({"owner":owner,"project":project,"workspace":workspace});
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    if Query::new("authority", &fields)?.run(tx).await?.is_empty() {
                        return Ok(None);
                    }
                    layout(&Query::new("get", &fields)?.run(tx).await?)
                })
            })
            .await
    }
    pub async fn execute(&self, owner: &str, input: &Value) -> Result<Option<Value>> {
        let command = parse("workspaceCommandSchema", input)?;
        let mut fields = json!({"owner":owner,"project":command["projectId"],"workspace":command["workspaceId"],"operation":command["operationId"],"command":command});
        self.database.transaction(|tx|Box::pin(async move {
            if Query::new("authority",&fields)?.run(tx).await?.is_empty() {return Ok(None);}
            let Some(layout)=layout(&Query::new("locked",&fields)?.run(tx).await?)? else {return Ok(None);};
            let window=values(&layout,"windows").iter().find(|w|w["id"]==command["windowId"]);
            if window.is_none_or(|w|w["attachmentGeneration"]!=command["attachmentGeneration"]) {
                return Err(command_error("attachment","The window attachment is no longer current."));
            }
            if let Some(receipt)=Query::new("receipt_get",&fields)?.run(tx).await?.first() {
                let original=receipt.get::<postgres_types::Json<Value>>(queries::column("workspaceCommandReceipts","command"))?.0;
                if !strict_equal(&original,&command) {return Err(command_error("invalid","The operation identity was already used for another command."));}
                return Ok(Some(json!({"layout":layout,"operationId":command["operationId"],"appliedRevision":receipt.get::<i64>(queries::column("workspaceCommandReceipts","appliedRevision"))?,"replayed":true,"focusWindowId":Value::Null,"emptyWindowIds":Vec::<Value>::new()})));
            }
            let mut effective=command.clone();
            let action=&command["action"];
            if action["type"]=="migrate-code-files" || action["type"]=="migrate-explorer-file" {migration(tx,&mut fields,action).await?;}
            if action["type"]=="open" {
                if action["tab"]["resource"]["kind"]=="entity" {
                    let label=resolve(tx,&mut fields,&action["tab"]["resource"]).await?.ok_or_else(||command_error("missing","The resource is unavailable in this project."))?;
                    effective["action"]["tab"]["titleProtection"]=label;
                }
                if truthy(action["tab"]["builtInState"].get("worktreeId")) {
                    fields["worktree"]=action["tab"]["builtInState"]["worktreeId"].clone();
                    if Query::new("builtin_worktree",&fields)?.run(tx).await?.is_empty() {return Err(command_error("missing","The worktree is unavailable in this project."));}
                }
            }
            let mut result=apply(&layout,&effective)?;
            placements(&result["layout"])?;
            fields["layout"]=result["layout"].clone();fields["appliedRevision"]=result["layout"]["revision"].clone();
            Query::new("update",&fields)?.run(tx).await?;
            Query::new("receipt_insert",&fields)?.run(tx).await?;
            result["appliedRevision"]=result["layout"]["revision"].clone();result["replayed"]=json!(false);
            Ok(Some(result))
        })).await
    }
    pub async fn import_legacy_files(
        &self,
        owner: &str,
        project: &str,
        workspace: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let input = parse("workspaceLegacyFileImportRequestSchema", input)?;
        let mut request = input.clone();
        let Value::Object(object) = &mut request else {
            unreachable!()
        };
        object.shift_remove("expectedRevision");
        let mut fields = json!({"owner":owner,"project":project,"workspace":workspace});
        self.database
            .transaction(|tx| {
                Box::pin(async move {
                    if Query::new("authority", &fields)?.run(tx).await?.is_empty() {
                        return Ok(None);
                    }
                    let Some(layout) = layout(&Query::new("locked", &fields)?.run(tx).await?)?
                    else {
                        return Ok(None);
                    };
                    let replay = values(&layout, "legacyFileImports")
                        .iter()
                        .any(|r| r["windowId"] == request["windowId"]);
                    if !replay && layout["revision"] != input["expectedRevision"] {
                        return Err(command_error(
                            "revision",
                            "Workspace revision changed before legacy import.",
                        ));
                    }
                    let mut titles = crate::wire::value::Object::new();
                    if !replay {
                        for view in values(&request, "views") {
                            fields["documents"] = Value::Array(vec![view["documentId"].clone()]);
                            if Query::new("import_document", &fields)?
                                .run(tx)
                                .await?
                                .is_empty()
                            {
                                return Err(command_error(
                                    "missing",
                                    "An imported document is unavailable in this project.",
                                ));
                            }
                            titles.insert(
                                view["documentId"].as_js_string().unwrap().clone(),
                                Value::Null,
                            );
                        }
                    }
                    let result = import_legacy_files(&layout, &request, &Value::Object(titles))?;
                    if result["replayed"] != true {
                        placements(&result["layout"])?;
                        fields["layout"] = result["layout"].clone();
                        Query::new("update", &fields)?.run(tx).await?;
                    }
                    Ok(Some(result))
                })
            })
            .await
    }
}

async fn resolve(
    tx: &Transaction<'_>,
    fields: &mut Value,
    resource: &Value,
) -> Result<Option<Value>> {
    let Some(kind) =
        queries::definition(&resource["definitionId"]).and_then(|d| d.tab_kind.as_deref())
    else {
        return Ok(None);
    };
    fields["resource"] = resource["resourceId"].clone();
    if resource["definitionId"] == "project.file"
        && !Query::new("resolve_document", fields)?
            .run(tx)
            .await?
            .is_empty()
    {
        return Ok(Some(Value::Null));
    }
    let query = match kind {
        "chat" => "resolve_chats",
        "terminal" => "resolve_terminals",
        "explorer" => "resolve_explorers",
        "browser" => "resolve_browsers",
        "code" => "resolve_codeTabs",
        _ => "resolve_projectViews",
    };
    fields["tabKind"] = json!(kind);
    Query::new(query, fields)?
        .run(tx)
        .await?
        .first()
        .map(|row| {
            row.get::<Option<postgres_types::Json<Value>>>(1)
                .map(|v| v.map(|v| v.0).unwrap_or(Value::Null))
        })
        .transpose()
}
async fn migration(tx: &Transaction<'_>, fields: &mut Value, action: &Value) -> Result<()> {
    let code = action["type"] == "migrate-code-files";
    let table = if code { "codeTabs" } else { "explorers" };
    fields["resource"] = action[if code { "codeId" } else { "explorerId" }].clone();
    let rows = Query::new(
        if code {
            "migration_codeTabs"
        } else {
            "migration_explorers"
        },
        fields,
    )?
    .run(tx)
    .await?;
    let Some(source) = rows.first() else {
        return Err(command_error(
            "missing",
            "Legacy editor is unavailable in this project.",
        ));
    };
    let worker = source.get::<Option<String>>(queries::column(table, "activeWorkerId"))?;
    let worktree = source.get::<Option<String>>(queries::column(table, "worktreeId"))?;
    let same = worker.as_ref().map_or(Value::Null, |v| json!(v)) == action["expectedWorkerId"]
        && worktree.as_ref().map_or(Value::Null, |v| json!(v)) == action["expectedWorktreeId"];
    if !same
        || (!code
            && !strict_equal(
                &source
                    .get::<Option<postgres_types::Json<Value>>>(queries::column(
                        table,
                        "protectedState",
                    ))?
                    .map(|v| v.0)
                    .unwrap_or(Value::Null),
                &action["expectedStateProtection"],
            ))
    {
        return Err(command_error(
            "invalid",
            "Legacy editor binding changed before migration.",
        ));
    }
    let ids = if code {
        values(action, "views")
            .iter()
            .map(|v| v["documentId"].clone())
            .collect::<Vec<_>>()
    } else {
        std::iter::once(action["documentId"].clone())
            .chain(
                values(action, "retainedViews")
                    .iter()
                    .map(|v| v["documentId"].clone()),
            )
            .collect()
    };
    fields["documents"] = Value::Array(ids.clone());
    let documents = Query::documents(fields)?.run(tx).await?;
    if documents.len() != ids.len() {
        return Err(command_error(
            "missing",
            "Migration document is unavailable in this project.",
        ));
    }
    if !code {
        let selected = documents
            .iter()
            .find(|r| {
                r.get::<String>(0)
                    .is_ok_and(|id| json!(id) == action["documentId"])
            })
            .ok_or_else(|| {
                ModelError::plain(
                    "TypeError",
                    "Cannot read properties of undefined (reading 'workerId')",
                )
            })?;
        if Some(selected.get::<String>(1)?) != worker
            || Some(selected.get::<String>(2)?) != worktree
        {
            return Err(command_error(
                "invalid",
                "Migration document does not match the Explorer worktree.",
            ));
        }
    }
    Ok(())
}
