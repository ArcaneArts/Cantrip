//! Actual coordinator/repositories with explicitly controlled turn/account/Task
//! collaborators. This does not substitute for production Task or handoff QA.
use anyhow::{Context, Result};
use cantrip_server::{
    chats::{
        Repository,
        live_mutations::Service as Live,
        managed_console::ManagedConsole,
        recovery::{self, TaskTransitions, scheduler::Scheduler},
        routing::ModelRouting,
    },
    database::Database,
    operations::logging::Logger,
    wire::Value,
    workers::command_bus::LimitedCommandBus,
};
use futures::{FutureExt, future::BoxFuture};
use std::sync::{Arc, Mutex};
macro_rules! json {
    ({$($key:literal:$value:expr),*$(,)?})=>{Value::object([$(( $key,Value::from_serialize(&$value))),*])};
    ($value:expr)=>{Value::from_serialize(&$value)};
}
struct ControlledTasks {
    input: Value,
    trace: Arc<Mutex<Vec<Value>>>,
}
impl TaskTransitions for ControlledTasks {
    fn recover(&self, owner: String, chat: String) -> BoxFuture<'static, Result<bool>> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"kind":"recover-task","owner":owner,"chat":chat}));
        let recovered = self.input["recoverTask"] == true;
        async move { Ok(recovered) }.boxed()
    }
    fn continue_goal(
        &self,
        owner: String,
        context: Value,
        input: Value,
    ) -> BoxFuture<'static, Result<bool>> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"kind":"continue-goal","owner":owner,"context":context,"input":input}));
        let continued = self.input["continueGoal"] == true;
        async move { Ok(continued) }.boxed()
    }
    fn reconcile(&self, owner: String) -> BoxFuture<'static, Result<()>> {
        self.trace
            .lock()
            .unwrap()
            .push(json!({"kind":"reconcile-tasks","owner":owner}));
        async { Ok(()) }.boxed()
    }
}
pub async fn run(
    database: Arc<Database>,
    input: &Value,
    live: Arc<Live>,
    commands: Arc<LimitedCommandBus>,
    routing: Arc<ModelRouting>,
    console: Arc<ManagedConsole>,
    logger: Logger,
) -> Result<Value> {
    let trace = Arc::new(Mutex::new(Vec::new()));
    let owner = input["owner"].as_str().context("Recovery owner")?;
    let chat = input["chat"].as_str().context("Recovery chat")?;
    let outcomes = Scheduler::new();
    let service = recovery::Service::new(recovery::Dependencies {
        database: database.clone(),
        live,
        commands,
        routing,
        console,
        logger,
        outcomes: outcomes.clone(),
        tasks: Arc::new(ControlledTasks {
            input: input.clone(),
            trace: trace.clone(),
        }),
        begin: {
            let (database, trace, input) = (database.clone(), trace.clone(), input.clone());
            Arc::new(move |owner, context, turn, options| {
                let (database, trace, input) = (database.clone(), trace.clone(), input.clone());
                async move {
                trace.lock().unwrap().push(json!({"kind":"begin","owner":owner,"context":context,"input":turn,"options":options}));
                if let Some(sql)=input["beginSql"].as_str(){database.execute(sql).await?;}
                anyhow::ensure!(input["failBegin"]!=true,"Controlled queued turn failure");
                Ok(Value::Null)
            }.boxed()
            })
        },
        prepare_account: {
            let (database, trace, input) = (database.clone(), trace.clone(), input.clone());
            Arc::new(move |owner, context| {
                let (database, trace, input) = (database.clone(), trace.clone(), input.clone());
                async move {
                    trace
                        .lock()
                        .unwrap()
                        .push(json!({"kind":"prepare-account","owner":owner,"context":context}));
                    anyhow::ensure!(
                        input["failAccount"] != true,
                        "Controlled queued account failure"
                    );
                    if let Some(sql) = input["accountSql"].as_str() {
                        database.execute(sql).await?;
                        return Repository::new(database)
                            .execution_context(
                                &owner,
                                context["chatId"].as_str().context("Queued account chat")?,
                            )
                            .await?
                            .context("Queued account chat disappeared");
                    }
                    Ok(context)
                }
                .boxed()
            })
        },
    });
    let mut results = Vec::new();
    match input["action"].as_str().unwrap_or("dispatch") {
        "dispatch" => {
            let count = input["count"].as_u64().unwrap_or(1);
            for result in
                futures::future::join_all((0..count).map(|_| service.dispatch(owner, chat))).await
            {
                result?;
                results.push(Value::Null);
            }
        }
        "transition" => results.push(json!(
            service.continue_worktree_transition(owner, chat).await?
        )),
        "resume" => {
            service
                .resume_transitions(owner, input["worker"].as_str().unwrap_or("alpha"))
                .await?;
            results.push(Value::Null);
        }
        "configure" => results.push(
            Repository::new(database)
                .set_model_configuration(owner, chat, &input["configuration"])
                .await?
                .unwrap_or(Value::Null),
        ),
        _ => anyhow::bail!("Unknown recovery fixture action"),
    }
    service.drained().await;
    outcomes.clear();
    outcomes.drained().await;
    Ok(json!({"results":results,"trace":Value::Array(trace.lock().unwrap().clone())}))
}
