//! Authenticated Host desktop target discovery and protected fleet inventory.
mod process;

use crate::{connection::Outbound, encryption::Service, http::checked};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, value::json};
use indexmap::IndexSet;
use process::{NativeError, Process};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, watch},
    task::JoinHandle,
    time::{Instant, timeout_at},
};

const DEADLINE: Duration = Duration::from_secs(15);
const REPLAY_LIMIT: usize = 1_000;
const HELPER_INVENTORY_LIMIT: usize = 4_096;

pub(crate) struct DesktopInventory {
    queue: mpsc::Sender<Scan>,
    task: JoinHandle<()>,
}

struct Scan {
    command: Value,
    epoch: u64,
    deadline: Instant,
    reply: oneshot::Sender<Result<Value>>,
}

impl DesktopInventory {
    pub(crate) fn start(
        root: &Path,
        environment: &cantrip_config::Environment,
        encryption: Arc<Service>,
        outgoing: Arc<Outbound>,
        stop: watch::Receiver<bool>,
    ) -> Self {
        let binary = environment
            .get("CANTRIP_CUA_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                root.join("bin")
                    .join(format!("cantrip-cua{}", std::env::consts::EXE_SUFFIX))
            });
        let (queue, input) = mpsc::channel(4);
        let task = tokio::spawn(run(binary, encryption, outgoing, input, stop));
        Self { queue, task }
    }

    pub(crate) fn submit(
        &self,
        command: Value,
        epoch: u64,
    ) -> Result<oneshot::Receiver<Result<Value>>> {
        let (reply, result) = oneshot::channel();
        self.queue
            .try_send(Scan {
                command,
                epoch,
                deadline: Instant::now() + DEADLINE,
                reply,
            })
            .map_err(|_| anyhow::anyhow!("Remote Desktop inventory is busy."))?;
        Ok(result)
    }

    pub(crate) async fn close(self) {
        drop(self.queue);
        let _ = self.task.await;
    }
}

async fn run(
    binary: PathBuf,
    encryption: Arc<Service>,
    outgoing: Arc<Outbound>,
    mut input: mpsc::Receiver<Scan>,
    mut stop: watch::Receiver<bool>,
) {
    let mut process = None;
    let mut replay = IndexSet::new();
    let mut epoch = outgoing.stream_epoch();
    loop {
        tokio::select! {
            biased;
            _ = stopped(&mut stop) => break,
            _ = epoch.changed() => retire(&mut process).await,
            scan = input.recv() => {
                let Some(scan) = scan else { break };
                let result = authorize(&encryption, &outgoing, &scan, &mut replay);
                let outcome = match result {
                    Ok(owner) => {
                        tokio::select! {
                            biased;
                            _ = stopped(&mut stop) => {
                                let _ = scan.reply.send(Err(anyhow::anyhow!("Remote Desktop inventory stopped.")));
                                break;
                            }
                            _ = connection_changed(&mut epoch, scan.epoch) => {
                                retire(&mut process).await;
                                Err(anyhow::anyhow!("Remote Desktop inventory authority expired."))
                            }
                            result = timeout_at(scan.deadline, targets(&mut process, &binary)) => {
                                match result {
                                    Ok(Ok(inventory)) => protect(&encryption, &outgoing, &scan, &owner, inventory),
                                    Ok(Err(error)) if error.is::<NativeError>() => Err(error),
                                    Ok(Err(error)) => {
                                        retire(&mut process).await;
                                        Err(error)
                                    }
                                    Err(_) => {
                                        retire(&mut process).await;
                                        Err(anyhow::anyhow!("Remote Desktop inventory timed out."))
                                    }
                                }
                            }
                        }
                    }
                    Err(error) => Err(error),
                };
                let _ = scan.reply.send(outcome);
            }
        }
    }
    retire(&mut process).await;
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|stopped| *stopped).await;
}

async fn connection_changed(epoch: &mut watch::Receiver<u64>, current: u64) {
    let _ = epoch.wait_for(|value| *value != current).await;
}

fn authorize(
    encryption: &Service,
    outgoing: &Outbound,
    scan: &Scan,
    replay: &mut IndexSet<JsString>,
) -> Result<JsString> {
    ensure!(
        outgoing.stream_current(scan.epoch),
        "Remote Desktop inventory authority expired."
    );
    ensure!(
        Instant::now() < scan.deadline,
        "Remote Desktop inventory timed out."
    );
    ensure!(
        scan.command["resourceId"].as_js_string() == Some(encryption.worker_id()),
        "Remote Desktop inventory targets another worker."
    );
    let identity = encryption.bound_component("surface-private-state", None)?;
    ensure!(
        identity.server_id == scan.command["serverId"],
        "Remote Desktop inventory has the wrong server binding."
    );
    let operation = scan.command["operationId"]
        .as_js_string()
        .context("Missing desktop inventory operation.")?;
    ensure!(
        replay.insert(operation.clone()),
        "Remote Desktop private-state operation was replayed."
    );
    if replay.len() > REPLAY_LIMIT {
        replay.shift_remove_index(0);
    }
    Ok(identity.owner_id)
}

async fn targets(process: &mut Option<Process>, binary: &Path) -> Result<Inventory> {
    if process.as_mut().is_some_and(Process::exited) {
        retire(process).await;
    }
    if process.is_none() {
        let child = Process::spawn(binary, &[])?;
        process.insert(child).initialize().await?;
    }
    read_inventory(process.as_mut().unwrap()).await
}

async fn retire(process: &mut Option<Process>) {
    if let Some(process) = process.take() {
        process.close().await;
    }
}

#[derive(Default)]
struct Inventory {
    monitors: Vec<Value>,
    windows: Vec<Value>,
    truncated: bool,
}

async fn read_inventory(process: &mut Process) -> Result<Inventory> {
    let mut inventory = Inventory::default();
    let mut seen = HashSet::new();
    let mut after: Option<JsString> = None;
    loop {
        let request = if let Some(cursor) = &after {
            json!({"operation":"targets.list","after":cursor})
        } else {
            json!({"operation":"targets.list"})
        };
        let page = process.request(request).await?;
        let targets = page["targets"]
            .as_array()
            .filter(|targets| targets.len() <= 256)
            .context("Invalid capture helper inventory page.")?;
        ensure!(
            page.as_object()
                .is_some_and(|fields| fields.keys().all(|key| {
                    matches!(key.as_str(), Some("targets" | "nextCursor" | "truncated"))
                }))
                && page
                    .get("truncated")
                    .is_none_or(|value| value.as_bool().is_some()),
            "Invalid capture helper inventory metadata."
        );
        let mut last = None;
        let mut ordered = true;
        for target in targets {
            let id = target_id(target)?;
            ordered &= last.is_none_or(|previous: &JsString| previous.units() < id.units())
                && after
                    .as_ref()
                    .is_none_or(|previous| previous.units() < id.units());
            last = Some(id);
            ensure!(
                seen.insert(id.clone()),
                "Capture helper repeated a desktop target."
            );
            ensure!(
                seen.len() <= HELPER_INVENTORY_LIMIT,
                "Capture helper inventory is too large."
            );
            inventory.add(id, target)?;
        }
        match page.get("nextCursor") {
            None => {
                inventory.truncated |= page["truncated"] == true;
                return Ok(inventory);
            }
            Some(cursor)
                if ordered
                    && page["truncated"] == true
                    && cursor
                        .as_js_string()
                        .is_some_and(|value| Some(value) == last) =>
            {
                after = cursor.as_js_string().cloned();
            }
            Some(_) => bail!("Invalid capture helper inventory cursor."),
        }
    }
}

fn target_id(target: &Value) -> Result<&JsString> {
    target["id"]
        .as_js_string()
        .filter(|id| {
            id.as_str().is_some_and(|s| {
                !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
            })
        })
        .context("Invalid capture helper target identity.")
}

impl Inventory {
    fn add(&mut self, id: &JsString, target: &Value) -> Result<()> {
        let id = id.as_str().unwrap();
        let id = id
            .strip_prefix("macos-window-")
            .or_else(|| id.strip_prefix("macos-display-"))
            .unwrap_or(id);
        let bounds = &target["bounds"];
        let coordinate = |field| -> Result<f64> {
            let number = bounds[field]
                .as_f64()
                .filter(|number| number.is_finite())
                .context("Invalid desktop target geometry.")?;
            let lower = number.floor();
            Ok(if number - lower >= 0.5 {
                lower + 1.0
            } else {
                lower
            })
        };
        let x = coordinate("x")?;
        let y = coordinate("y")?;
        let width = coordinate("width")?.max(1.0);
        let height = coordinate("height")?.max(1.0);
        let title = nonempty(&target["title"]);
        let entry = match target["kind"].as_str() {
            Some("monitor") if self.monitors.len() < 64 => {
                let primary = self.monitors.is_empty();
                let fallback = format!("Display {}", self.monitors.len() + 1);
                self.monitors.push(json!({
                    "kind":"monitor","id":id,"name":title.unwrap_or(&fallback),
                    "x":x,"y":y,"width":width,"height":height,"primary":primary
                }));
                return Ok(());
            }
            Some("window") if self.windows.len() < 2_000 => json!({
                "kind":"window","id":id,"application":nonempty(&target["application"]).unwrap_or("Application"),
                "title":title.unwrap_or("Untitled window"),"iconKey":Value::Null,
                "x":x,"y":y,"width":width,"height":height,
                "focused":target["focused"] == true,"minimized":target["minimized"] == true
            }),
            Some("window" | "monitor") => {
                self.truncated = true;
                return Ok(());
            }
            _ => bail!("Invalid capture helper target kind."),
        };
        self.windows.push(entry);
        Ok(())
    }
}

fn nonempty(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| !text.is_empty())
}

fn protect(
    encryption: &Service,
    outgoing: &Outbound,
    scan: &Scan,
    owner: &JsString,
    mut inventory: Inventory,
) -> Result<Value> {
    let identity = encryption.bound_component("surface-private-state", None)?;
    ensure!(
        identity.owner_id == *owner
            && identity.server_id == scan.command["serverId"]
            && outgoing.stream_current(scan.epoch),
        "Remote Desktop inventory authority expired."
    );
    let limit = scan.command["limit"]
        .as_u64()
        .context("Missing Remote Desktop inventory limit.")? as usize;
    let count = inventory.monitors.len() + inventory.windows.len();
    inventory.monitors.truncate(limit);
    inventory.windows.truncate(limit - inventory.monitors.len());
    let monitor_count = inventory.monitors.len();
    let window_count = inventory.windows.len();
    let operation = &scan.command["operationId"];
    let content = json!({
        "version":1,"classification":json!({"recordKind":"remote-desktop-inventory"}),
        "monitors":inventory.monitors,"windows":inventory.windows,
        "requested":Value::Null,"active":Value::Null,"launchingApplication":Value::Null,"message":Value::Null
    });
    let opaque = cantrip_crypto::content::encrypt_surface_private_state(
        &identity.component.key,
        &json!({"ownerId":owner,"keyRevision":identity.component.key_revision,"context":json!({
            "serverId":identity.server_id,"resource":"remote-desktop-inventory",
            "resourceId":scan.command["resourceId"],"operationId":operation,"recordKind":"remote-desktop-inventory"
        })}),
        &content,
    )?;
    checked(
        "remoteDesktopProtectedInventorySchema",
        &json!({
            "operationId":operation,"stateProtection":opaque,
            "monitorCount":monitor_count,"windowCount":window_count,
            "truncated":inventory.truncated || count != monitor_count + window_count
        }),
    )
}
