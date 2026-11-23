use super::*;
use cantrip_worker::inference::admission::Ownership;
#[derive(Default)]
pub struct Gates(Mutex<HashMap<String, Arc<Gate>>>);
struct Gate {
    held: tokio::sync::watch::Sender<bool>,
    seen: tokio::sync::watch::Sender<u64>,
}
impl Gates {
    fn get(&self, action: &str) -> Arc<Gate> {
        self.0
            .lock()
            .unwrap()
            .entry(action.into())
            .or_insert_with(|| {
                Arc::new(Gate {
                    held: tokio::sync::watch::channel(false).0,
                    seen: tokio::sync::watch::channel(0).0,
                })
            })
            .clone()
    }
    pub fn hold(&self, action: &str, held: bool) {
        self.get(action).held.send_replace(held);
    }
    pub fn release_all(&self) {
        for gate in self.0.lock().unwrap().values() {
            gate.held.send_replace(false);
        }
    }
    pub async fn barrier(&self, action: &str, target: u64) -> Result<()> {
        let gate = self.get(action);
        let mut seen = gate.seen.subscribe();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if *seen.borrow_and_update() >= target {
                    break;
                }
                seen.changed().await?;
            }
            Ok::<_, anyhow::Error>(())
        })
        .await??;
        Ok(())
    }
    async fn committed(&self, action: &str) -> Result<()> {
        let gate = self.get(action);
        gate.seen.send_modify(|seen| *seen += 1);
        let mut held = gate.held.subscribe();
        loop {
            if !*held.borrow_and_update() {
                return Ok(());
            }
            held.changed().await?;
        }
    }
}
pub struct Proxy {
    pub owner: cantrip_worker::inference::ownership::Owner,
    pub gates: Arc<Gates>,
}
impl Ownership for Proxy {
    fn available(&self) -> bool {
        self.owner.available()
    }
    fn prepare(&self, generation: JsString) -> Work<HashMap<String, String>> {
        self.owner.prepare(generation)
    }
    fn retire(&self, generation: JsString) -> Work<()> {
        let work = self.owner.retire(generation);
        let gates = self.gates.clone();
        cantrip_transport::lifecycle::owned(async move {
            work.await?;
            gates.committed("retire").await
        })
    }
    fn close(&self) -> Work<()> {
        self.owner.close()
    }
    fn on_lost(&self, listener: cantrip_worker::inference::ownership::LostListener) {
        self.owner.on_lost(listener);
    }
    fn journal(&self, command: Value) -> Work<Option<Value>> {
        let work = self.owner.journal(command.clone());
        let gates = self.gates.clone();
        cantrip_transport::lifecycle::owned(async move {
            let result = work.await?;
            if command["action"] == "batch" {
                if let Some(results) = result.as_ref().and_then(Value::as_array) {
                    for (mutation, result) in
                        command["commands"].as_array().unwrap().iter().zip(results)
                    {
                        if result["ok"] == true {
                            gates
                                .committed(mutation["action"].as_str().unwrap())
                                .await?;
                        }
                    }
                }
            } else {
                gates.committed(command["action"].as_str().unwrap()).await?;
            }
            Ok(result)
        })
    }
}
