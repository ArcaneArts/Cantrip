//! Loopback-only test adapter around the actual router, auth and WorkerBridge.
//! This is not a production server entrypoint or an implementation of domains.
use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use cantrip_server::{
    auth::service::AuthService,
    config::{DatabaseMode, Environment, ServerConfig},
    database::Database,
    http,
    managed_postgres::ManagedPostgres,
    migrations::migrate,
    wire::Value,
    workers::bridge::{CommandError, EventHandler, NotificationHandler, NotificationSubscription},
};
use clap::{Parser, ValueEnum};
use std::{
    collections::{BTreeMap, HashMap},
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

#[derive(Parser)]
struct Arguments {
    #[arg(long, default_value_t = 0)]
    port: u16,
    #[arg(long)]
    database: DatabaseMode,
    #[arg(long)]
    shutdown_on_stdin_close: bool,
}
struct Fixture {
    service: Arc<AuthService>,
    started: Mutex<Vec<Value>>,
    completed: Mutex<Vec<Value>>,
    settled: Mutex<BTreeMap<String, bool>>,
    gates: Mutex<HashMap<String, watch::Sender<bool>>>,
    subscriptions: Mutex<HashMap<String, NotificationSubscription>>,
}
fn text(body: &Value, key: &str) -> String {
    body[key].as_str().expect("fixture string field").into()
}
fn boolean(body: &Value, key: &str) -> bool {
    body[key].as_bool().unwrap_or(false)
}
fn ok() -> Json<Value> {
    Json(Value::object([("ok", Value::Bool(true))]))
}
impl Fixture {
    fn gate(&self, key: &str) -> watch::Receiver<bool> {
        self.gates
            .lock()
            .unwrap()
            .entry(key.into())
            .or_insert_with(|| watch::channel(false).0)
            .subscribe()
    }
    async fn wait(&self, key: &str) {
        let mut receiver = self.gate(key);
        while !*receiver.borrow() {
            if receiver.changed().await.is_err() {
                break;
            }
        }
    }
    fn release(&self, key: &str) {
        self.gates
            .lock()
            .unwrap()
            .entry(key.into())
            .or_insert_with(|| watch::channel(false).0)
            .send_replace(true);
    }
    fn record(&self, completed: bool, kind: &str, key: &str, value: Value) {
        let entry = Value::object([
            ("kind", Value::String(kind.into())),
            ("key", Value::String(key.into())),
            ("value", value),
        ]);
        if completed {
            self.completed.lock().unwrap().push(entry);
        } else {
            self.started.lock().unwrap().push(entry);
        }
    }
    fn close(&self) {
        for gate in self.gates.lock().unwrap().values() {
            gate.send_replace(true);
        }
        self.subscriptions.lock().unwrap().clear();
    }
}
async fn snapshot(State(f): State<Arc<Fixture>>) -> Json<Value> {
    Json(Value::object([
        ("started", Value::Array(f.started.lock().unwrap().clone())),
        (
            "completed",
            Value::Array(f.completed.lock().unwrap().clone()),
        ),
        (
            "settled",
            Value::from_serialize(&*f.settled.lock().unwrap()),
        ),
        (
            "stats",
            Value::from_serialize(&f.service.workers.bridge.stats()),
        ),
    ]))
}
async fn release(State(f): State<Arc<Fixture>>, Json(body): Json<Value>) -> Json<Value> {
    f.release(&text(&body, "key"));
    ok()
}
async fn subscribe(State(f): State<Arc<Fixture>>, Json(body): Json<Value>) -> Json<Value> {
    let key = text(&body, "key");
    let worker = text(&body, "workerId");
    let hold = boolean(&body, "hold");
    let fail = boolean(&body, "fail");
    f.subscriptions.lock().unwrap().remove(&key);
    let callback_key = key.clone();
    let weak = Arc::downgrade(&f);
    let handler: NotificationHandler = Arc::new(move |value| {
        let weak = weak.clone();
        let key = callback_key.clone();
        Box::pin(async move {
            let f = weak.upgrade().context("fixture closed")?;
            f.record(false, "notification", &key, (*value).clone());
            if hold {
                f.wait(&key).await;
            }
            if fail {
                anyhow::bail!("Controlled notification failure");
            }
            f.record(true, "notification", &key, (*value).clone());
            Ok(())
        })
    });
    let subscription = f
        .service
        .workers
        .bridge
        .subscribe_notifications(&worker, handler);
    f.subscriptions.lock().unwrap().insert(key, subscription);
    ok()
}
async fn unsubscribe(State(f): State<Arc<Fixture>>, Json(body): Json<Value>) -> Json<Value> {
    f.subscriptions.lock().unwrap().remove(&text(&body, "key"));
    ok()
}
async fn request(State(f): State<Arc<Fixture>>, Json(body): Json<Value>) -> Json<Value> {
    let key = text(&body, "key");
    let worker = text(&body, "workerId");
    let hold = boolean(&body, "hold");
    let fail = boolean(&body, "fail");
    f.settled.lock().unwrap().insert(key.clone(), false);
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let callback_key = key.clone();
    let weak = Arc::downgrade(&f);
    let handler: EventHandler = Arc::new(move |value| {
        let weak = weak.clone();
        let key = callback_key.clone();
        let first = count.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0;
        Box::pin(async move {
            let f = weak
                .upgrade()
                .expect("fixture remains alive for its request");
            f.record(false, "event", &key, value.clone());
            if hold && first {
                f.wait(&key).await;
            }
            if fail {
                return Err(CommandError {
                    message: "Controlled event failure".into(),
                    code: None,
                    unavailable: false,
                });
            }
            f.record(true, "event", &key, value);
            Ok(())
        })
    });
    let result = f
        .service
        .workers
        .bridge
        .request(
            &worker,
            body["command"].clone(),
            Some(Duration::from_millis(
                body["timeoutMs"].as_u64().unwrap_or(2000),
            )),
            Some(handler),
        )
        .await;
    f.settled.lock().unwrap().insert(key, true);
    let response = match result {
        Ok(result) => {
            let mut value = Value::object([
                ("ok", Value::Bool(true)),
                ("resultPresent", Value::Bool(result.is_some())),
            ]);
            if let Some(result) = result {
                value["result"] = result;
            }
            value
        }
        Err(error) => Value::object([
            ("ok", Value::Bool(false)),
            ("message", Value::String(error.message)),
            (
                "code",
                error.code.map_or(Value::Null, |v| Value::String(v.into())),
            ),
        ]),
    };
    Json(response)
}
#[tokio::main]
async fn main() -> Result<()> {
    if cantrip_server::managed_postgres::run_owner_if_requested().await? {
        return Ok(());
    }
    let args = Arguments::parse();
    let mut environment: Environment = std::env::vars().collect();
    environment.insert(
        "CANTRIP_DATABASE_MODE".into(),
        args.database.to_possible_value().unwrap().get_name().into(),
    );
    let config = Arc::new(ServerConfig::read(&environment, &std::env::current_dir()?)?);
    let mut parent_output = os_pipe::dup_stdout()?;
    let mut parent_input = os_pipe::dup_stdin()?;
    let mut managed = None;
    let database = Arc::new(match config.database_mode {
        DatabaseMode::Pglite => Database::pglite(&config.data_directory.join("server-db")).await?,
        DatabaseMode::Postgres => {
            Database::postgres_url(
                config
                    .database_url
                    .as_deref()
                    .context("fixture DATABASE_URL")?,
            )
            .await?
        }
        DatabaseMode::BundledPostgres => {
            let runtime = ManagedPostgres::start(
                &config.data_directory.join("postgres"),
                config
                    .postgres_bin_directory
                    .as_deref()
                    .context("fixture PostgreSQL binaries")?,
            )
            .await?;
            let database = Database::postgres(runtime.configuration()).await?;
            managed = Some(runtime);
            database
        }
    });
    migrate(&database).await?;
    let service = AuthService::initialize(database.clone(), config).await?;
    let f = Arc::new(Fixture {
        service: service.clone(),
        started: Mutex::new(Vec::new()),
        completed: Mutex::new(Vec::new()),
        settled: Mutex::new(BTreeMap::new()),
        gates: Mutex::new(HashMap::new()),
        subscriptions: Mutex::new(HashMap::new()),
    });
    let routes = Router::new()
        .route("/__worker_ingress/state", get(snapshot))
        .route("/__worker_ingress/release", post(release))
        .route("/__worker_ingress/subscribe", post(subscribe))
        .route("/__worker_ingress/unsubscribe", post(unsubscribe))
        .route("/__worker_ingress/request", post(request))
        .with_state(f.clone());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", args.port)).await?;
    writeln!(
        parent_output,
        "\n{}",
        serde_json::json!({"event":"server.listening","origin":format!("http://{}",listener.local_addr()?)})
    )?;
    let (closed, closing) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let mut bytes = [0; 256];
        while parent_input.read(&mut bytes).is_ok_and(|count| count > 0) {}
        let _ = closed.send(());
    });
    let close_service = service.clone();
    axum::serve(
        listener,
        http::router(service.clone())
            .merge(routes)
            .into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        if args.shutdown_on_stdin_close {
            let _ = closing.await;
        } else {
            let _ = tokio::signal::ctrl_c().await;
        }
        f.close();
        close_service.live.transports.pre_close();
        close_service.live.close();
        close_service.workers.close();
    })
    .await?;
    service.live.transports.drained().await;
    service.workers.drained().await?;
    database.close().await?;
    if let Some(runtime) = managed {
        runtime.close().await?;
    }
    Ok(())
}
