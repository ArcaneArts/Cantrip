use super::{Scope, Service, opaque, output, render, revoked, scope};
use crate::browser_surface::{AgentPage, AgentTarget};
use anyhow::{Context, Result, bail, ensure};
use cantrip_wire::{JsString, Value, value::json};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{Mutex as AsyncMutex, watch},
    time::{Instant, sleep, timeout},
};
use url::Url;

#[derive(Default)]
pub(in crate::web) struct Visible {
    records: Mutex<HashMap<String, Arc<Record>>>,
}

struct Record {
    scope: Scope,
    page: AgentPage,
    state: AsyncMutex<State>,
}

struct State {
    generation: u64,
    key: String,
    snapshot: Option<Snapshot>,
}

struct Snapshot {
    world: u64,
    elements: HashMap<String, usize>,
}

struct Control<'a> {
    record: &'a Record,
    lane: watch::Receiver<bool>,
}

impl Service {
    pub(crate) fn has_visible_browsers(&self) -> bool {
        self.browser_surfaces.is_some()
    }

    pub(crate) async fn open_visible(
        self: &Arc<Self>,
        binding: &Value,
        target: AgentTarget,
        args: &Value,
        mut lane: watch::Receiver<bool>,
    ) -> Result<Value> {
        ensure!(
            binding["contextKind"] == "project" && binding["permissionProfileId"] != ":read-only",
            "This MCP binding does not allow browser sessions."
        );
        let manager = self
            .browser_surfaces
            .as_ref()
            .context("Visible Browser targets are unavailable.")?;
        let scope = scope(binding)?;
        let page = tokio::select! {
            biased;
            _ = revoked(&mut lane) => bail!("Browser operation stopped with its agent turn."),
            page = manager.agent_page(target) => page?,
        };
        let id = opaque("wss")?;
        let record = Arc::new(Record {
            scope,
            page,
            state: AsyncMutex::new(State {
                generation: 1,
                key: opaque("cantrip")?,
                snapshot: None,
            }),
        });
        let result = self
            .visible_operation(
                record.clone(),
                id.clone(),
                "web.session.open",
                args.clone(),
                lane,
            )
            .await?;
        let mut records = self.visible.records.lock().unwrap();
        records.retain(|_, record| record.page.check().is_ok());
        records.insert(id, record);
        Ok(result)
    }

    pub(super) async fn session_on_visible(
        self: &Arc<Self>,
        caller: &Scope,
        id: &str,
        operation: &'static str,
        args: &Value,
        lane: watch::Receiver<bool>,
    ) -> Result<Option<Value>> {
        let record = self.visible.records.lock().unwrap().get(id).cloned();
        let Some(record) = record else {
            return Ok(None);
        };
        ensure!(
            &record.scope == caller,
            "Browser session belongs to another conversation."
        );
        if let Err(error) = record.page.check() {
            self.visible.records.lock().unwrap().remove(id);
            return Err(error);
        }
        self.visible_operation(record, id.into(), operation, args.clone(), lane)
            .await
            .map(Some)
    }

    async fn visible_operation(
        self: &Arc<Self>,
        record: Arc<Record>,
        id: String,
        operation: &'static str,
        args: Value,
        lane: watch::Receiver<bool>,
    ) -> Result<Value> {
        let permit = record.page.claim()?;
        let service = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let control = Control {
                record: &record,
                lane,
            };
            let mut state = record
                .state
                .try_lock()
                .context("Browser session has another agent operation in progress.")?;
            let result = service
                .visible_call(&control, &mut state, &id, operation, args)
                .await;
            if *control.lane.borrow() || operation == "web.session.close" {
                record.page.hide(&record.scope.1).await;
            }
            result
        })
        .await?
    }

    async fn visible_call(
        &self,
        control: &Control<'_>,
        state: &mut State,
        id: &str,
        operation: &str,
        args: Value,
    ) -> Result<Value> {
        control.check()?;
        let (tool, summary, mutated, data) = match operation {
            "web.session.open" => {
                let url = url(&args)?;
                let candidate = super::normalize(url.clone())?;
                control
                    .wait(self.robots.check(&self.network, &candidate))
                    .await?;
                control.record.page.start(&control.record.scope.1);
                state.invalidate(control).await;
                control.navigate(&url).await?;
                let summary = if args.get("sessionId").is_some() {
                    "Navigated"
                } else {
                    "Opened"
                };
                (
                    "web_session_open",
                    format!("{summary} web session {id}."),
                    true,
                    control.state(id, state.generation).await?,
                )
            }
            "web.session.snapshot" => {
                state.invalidate(control).await;
                let maximum = args["maxChars"].as_u64().unwrap() as usize;
                let result = state.capture(control, id, maximum).await?;
                (
                    "web_session_snapshot",
                    format!("Read generation {} of web session {id}.", state.generation),
                    false,
                    result,
                )
            }
            "web.session.pointer" => {
                state.invalidate(control).await;
                let from = coordinates(&args)?;
                let to = args.get("to").map(coordinates).transpose()?;
                let action = args["action"].as_str().unwrap();
                let duration = args["durationMs"].as_f64().unwrap_or(if action == "drag" {
                    200.0
                } else {
                    0.0
                });
                control
                    .gesture(action, from, to, Duration::from_secs_f64(duration / 1000.0))
                    .await?;
                (
                    "web_session_pointer",
                    format!("Dispatched browser {action} in session {id}."),
                    true,
                    control.state(id, state.generation).await?,
                )
            }
            "web.session.click" => {
                let element = state.element(&args)?;
                let point = control.element(element, &state.key, r#"
                    if (!node?.isConnected || node.matches(':disabled,[aria-disabled="true"]')) return null;
                    node.scrollIntoView({ block:'center', inline:'center', behavior:'instant' });
                    const r = node.getBoundingClientRect();
                    const left = Math.max(0,r.left), right = Math.min(innerWidth,r.right);
                    const top = Math.max(0,r.top), bottom = Math.min(innerHeight,r.bottom);
                    if (left >= right || top >= bottom) return null;
                    const x = (left + right)/2, y = (top + bottom)/2;
                    const hit = document.elementFromPoint(x,y);
                    return hit && node.contains(hit) ? {x,y} : null;
                "#).await?;
                let point = coordinates(&point)
                    .context("Element is detached or covered; take a fresh snapshot.")?;
                state.invalidate(control).await;
                control
                    .gesture("click", point, None, Duration::ZERO)
                    .await?;
                (
                    "web_session_click",
                    format!("Clicked an element in web session {id}."),
                    true,
                    control.state(id, state.generation).await?,
                )
            }
            "web.session.type" => {
                let element = state.element(&args)?;
                let ready = control.element(element, &state.key, r#"
                    if (!node?.isConnected || node.matches(':disabled,[aria-disabled="true"]') || node.readOnly) return false;
                    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable)) return false;
                    node.focus();
                    if (document.activeElement !== node && !node.contains(document.activeElement)) return false;
                    if (node.select) node.select();
                    else {
                        const range = document.createRange();
                        range.selectNodeContents(node);
                        const selection = getSelection();
                        selection.removeAllRanges();
                        selection.addRange(range);
                    }
                    return true;
                "#).await?;
                ensure!(
                    ready == true,
                    "Element is no longer editable; take a fresh snapshot."
                );
                state.invalidate(control).await;
                if args["text"].as_js_string().is_some_and(JsString::is_empty) {
                    control.key("Backspace", 8).await?;
                } else {
                    control
                        .command("Input.insertText", json!({"text":args["text"]}))
                        .await?;
                }
                if args["submit"] == true {
                    control.key("Enter", 13).await?;
                }
                (
                    "web_session_type",
                    format!("Typed into an element in web session {id}."),
                    true,
                    control.state(id, state.generation).await?,
                )
            }
            "web.session.close" => {
                self.visible.records.lock().unwrap().remove(id);
                state.invalidate(control).await;
                (
                    "web_session_close",
                    format!("Closed web session {id}."),
                    true,
                    json!({"sessionId":id,"closed":true}),
                )
            }
            _ => bail!("The Browser operation is unavailable."),
        };
        control.check()?;
        output(tool, summary, mutated, data)
    }
}

impl State {
    async fn invalidate(&mut self, control: &Control<'_>) {
        self.generation += 1;
        if let Some(snapshot) = self.snapshot.take() {
            let remove = format!("delete globalThis[{}]", json!(self.key).stringify());
            let _ = control
                .wait(
                    control
                        .record
                        .page
                        .page()
                        .evaluate_in(&remove, Some(snapshot.world)),
                )
                .await;
        }
    }

    fn element(&self, args: &Value) -> Result<(u64, usize)> {
        let snapshot = self
            .snapshot
            .as_ref()
            .context("Element reference is stale; take a fresh browser snapshot.")?;
        let index = snapshot
            .elements
            .get(args["elementRef"].as_str().unwrap())
            .copied()
            .context("Element reference is stale; take a fresh browser snapshot.")?;
        Ok((snapshot.world, index))
    }

    async fn capture(&mut self, control: &Control<'_>, id: &str, maximum: usize) -> Result<Value> {
        let page = control.record.page.page();
        let world = control.wait(render::isolated_world(page)).await?;
        let key = json!(self.key).stringify();
        let expression = format!(
            r#"(() => {{
            const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]'))
              .filter(n => n.getClientRects().length).slice(0,100);
            globalThis[{key}] = nodes;
            return {{text:(document.body?.innerText || '').slice(0,{maximum}),
                elements:nodes.map(n => (n.getAttribute('aria-label') || n.innerText || n.getAttribute('placeholder')
                    || n.getAttribute('name') || n.tagName).slice(0,500))}};
        }})()"#
        );
        let values = control
            .wait(page.evaluate_in(&expression, Some(world)))
            .await?;
        let mut elements = Vec::new();
        let mut references = HashMap::new();
        for (index, description) in values["elements"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let reference = opaque("wer")?;
            references.insert(reference.clone(), index);
            elements.push(json!({"ref":reference,"description":description}));
        }
        self.snapshot = Some(Snapshot {
            world,
            elements: references,
        });
        let mut state = control.state(id, self.generation).await?;
        state["snapshot"] = values["text"].clone();
        state["elements"] = json!(elements);
        state["truncated"] = json!(
            values["text"]
                .as_js_string()
                .is_some_and(|snapshot| snapshot.len() >= maximum)
        );
        Ok(state)
    }
}

impl Control<'_> {
    fn check(&self) -> Result<()> {
        ensure!(
            !*self.lane.borrow(),
            "Browser operation stopped with its agent turn."
        );
        self.record.page.check()
    }

    async fn wait<T>(&self, action: impl Future<Output = Result<T>>) -> Result<T> {
        self.check()?;
        let mut lane = self.lane.clone();
        let mut closed = self.record.page.closed();
        tokio::select! {
            biased;
            _ = revoked(&mut lane) => bail!("Browser operation stopped with its agent turn."),
            _ = revoked(&mut closed) => bail!("Browser target was replaced or closed. Input was not replayed."),
            result = action => result,
        }
    }

    async fn command(&self, method: &str, input: Value) -> Result<Value> {
        self.wait(self.record.page.page().request(method, input))
            .await
    }

    async fn navigate(&self, url: &Url) -> Result<()> {
        let page = self.record.page.page();
        let mut events = page.subscribe();
        self.command("Page.setLifecycleEventsEnabled", json!({"enabled":true}))
            .await?;
        self.wait(async {
            timeout(Duration::from_secs(30), async {
                let result = page
                    .request("Page.navigate", json!({"url":url.as_str()}))
                    .await?;
                ensure!(
                    result["errorText"].is_null(),
                    "Chromium could not load the Browser target."
                );
                if let Some(loader) = result["loaderId"].as_js_string() {
                    let frame = result["frameId"]
                        .as_js_string()
                        .context("Chromium did not return the Browser frame.")?;
                    render::loaded(&mut events, loader, frame).await?;
                }
                Ok(())
            })
            .await
            .context("Browser navigation did not become ready.")?
        })
        .await
    }

    async fn state(&self, id: &str, generation: u64) -> Result<Value> {
        let page = self.record.page.page();
        let world = self.wait(render::isolated_world(page)).await?;
        let values = self
            .wait(page.evaluate_in(
                "({title:document.title.slice(0,1000),url:location.href})",
                Some(world),
            ))
            .await?;
        Ok(
            json!({"sessionId":id,"generation":generation,"persistent":true,"title":values["title"],"url":values["url"]}),
        )
    }

    async fn element(&self, (world, index): (u64, usize), key: &str, body: &str) -> Result<Value> {
        let expression = format!(
            "(() => {{ const node = globalThis[{}]?.[{index}]; {body} }})()",
            json!(key).stringify()
        );
        self.wait(
            self.record
                .page
                .page()
                .evaluate_in(&expression, Some(world)),
        )
        .await
        .context("Element reference is stale; take a fresh browser snapshot.")
    }

    async fn gesture(
        &self,
        action: &str,
        from: (f64, f64),
        to: Option<(f64, f64)>,
        duration: Duration,
    ) -> Result<()> {
        let mut point = from;
        self.mouse("mouseMoved", point, false).await?;
        if action == "move" {
            return Ok(());
        }
        self.check()?;
        // A failed response does not establish that Chromium missed the down.
        let result = async {
            self.mouse("mousePressed", point, true).await?;
            let started = Instant::now();
            if let Some(to) = to {
                loop {
                    self.wait(async {
                        sleep(
                            duration
                                .saturating_sub(started.elapsed())
                                .min(Duration::from_micros(16_667)),
                        )
                        .await;
                        Ok(())
                    })
                    .await?;
                    let progress = if duration.is_zero() {
                        1.0
                    } else {
                        (started.elapsed().as_secs_f64() / duration.as_secs_f64()).min(1.0)
                    };
                    point = (
                        from.0 + (to.0 - from.0) * progress,
                        from.1 + (to.1 - from.1) * progress,
                    );
                    self.mouse("mouseMoved", point, true).await?;
                    if progress >= 1.0 {
                        break;
                    }
                }
            } else {
                self.wait(async {
                    sleep(duration).await;
                    Ok(())
                })
                .await?;
            }
            Ok(())
        }
        .await;
        let released = self
            .release(
                "Input.dispatchMouseEvent",
                mouse("mouseReleased", point, false),
            )
            .await;
        if released.is_ok() {
            self.record
                .page
                .pointer(&self.record.scope.1, point.0, point.1, false, false);
        }
        result.and(released)
    }

    async fn mouse(&self, kind: &str, point: (f64, f64), pressed: bool) -> Result<()> {
        self.command("Input.dispatchMouseEvent", mouse(kind, point, pressed))
            .await?;
        self.record.page.pointer(
            &self.record.scope.1,
            point.0,
            point.1,
            kind == "mousePressed",
            pressed,
        );
        Ok(())
    }

    async fn key(&self, key: &str, code: u64) -> Result<()> {
        self.check()?;
        let down = self
            .command(
                "Input.dispatchKeyEvent",
                json!({
                    "type":"keyDown","key":key,"code":key,"windowsVirtualKeyCode":code,
                    "text":if key == "Enter" {"\r"} else {""},
                }),
            )
            .await
            .map(|_| ());
        let up = self
            .release(
                "Input.dispatchKeyEvent",
                json!({
                    "type":"keyUp","key":key,"code":key,"windowsVirtualKeyCode":code,
                }),
            )
            .await;
        down.and(up)
    }

    async fn release(&self, method: &str, input: Value) -> Result<()> {
        // Release only on the old, still-owned page, even after lane withdrawal.
        self.record.page.check()?;
        timeout(
            Duration::from_secs(2),
            self.record.page.page().request(method, input),
        )
        .await??;
        Ok(())
    }
}

fn url(args: &Value) -> Result<Url> {
    let value = args["url"].as_js_string().context("Missing Browser URL.")?;
    let target = Url::parse(&value.lossy())?;
    ensure!(
        matches!(target.scheme(), "http" | "https"),
        "Browser navigation requires HTTP or HTTPS."
    );
    Ok(target)
}

fn coordinates(value: &Value) -> Result<(f64, f64)> {
    Ok((
        value["x"]
            .as_f64()
            .context("Missing Browser pointer x coordinate.")?,
        value["y"]
            .as_f64()
            .context("Missing Browser pointer y coordinate.")?,
    ))
}

fn mouse(kind: &str, (x, y): (f64, f64), pressed: bool) -> Value {
    json!({"type":kind,"x":x,"y":y,"button":if kind != "mouseMoved" || pressed {"left"} else {"none"},
        "buttons":u8::from(pressed),"clickCount":if kind == "mouseMoved" {0} else {1}})
}

#[cfg(test)]
pub(crate) async fn test_visible(manager: &crate::managed_web::Manager) -> Result<()> {
    let (_deny, address) = render::DenyProxy::start().await?;
    manager.with_browser(address, false, async |browser| {
        let page = browser.new_page(None).await?;
        page.request("Page.enable", json!({})).await?;
        let tree = page.request("Page.getFrameTree", json!({})).await?;
        page.request("Page.setDocumentContent", json!({
            "frameId":tree["frameTree"]["frame"]["id"],
            "html":r#"<title>Visible fixture</title><style>
                body{margin:0}.pad{position:absolute;left:0;top:0;width:350px;height:150px;background:#ddd}
                button,input{position:absolute;left:450px} input{top:30px}
            </style><div class="pad">Pointer fixture</div>
            <button onclick="this.textContent='Clicked'">Click target</button>
            <input aria-label="Plain input"><script>
            globalThis.gesture=[];
            for (const event of ['mousedown','mousemove','mouseup']) document.addEventListener(event, e=>{
                if(e.clientX < 350) gesture.push([event,e.clientX,e.buttons]);
            });
            </script>"#,
        })).await?;
        crate::browser_surface::with_owned_fixture(page.clone(), async |agent, generation, mut cursor| {
            let service = Arc::new(Service::default());
            let binding = json!({"ownerId":"owner","chatId":"chat","contextKind":"project","permissionProfileId":":workspace"});
            let scope = scope(&binding)?;
            let id = opaque("wss")?;
            let record = Arc::new(Record {
                scope: scope.clone(),
                page: agent,
                state: AsyncMutex::new(State { generation: 2, snapshot: None, key: opaque("cantrip")? }),
            });
            let (lane, live) = watch::channel(false);
            let call = |operation: &'static str, args: Value| {
                let live = live.clone();
                let service = &service;
                let id = &id;
                let scope = &scope;
                async move {
                    service.session_on_visible(scope, id, operation, &args, live).await?
                        .context("Missing visible fixture session.")
                }
            };
            service.visible.records.lock().unwrap().insert(id.clone(), record.clone());
            let snapshot = call("web.session.snapshot", json!({"maxChars":1000})).await?;
            assert_eq!(snapshot["data"]["title"], "Visible fixture");
            assert_eq!(snapshot["data"]["generation"], 3);
            assert_eq!(snapshot["data"]["persistent"], true);
            let elements = snapshot["data"]["elements"].as_array().unwrap();
            let button = elements.iter().find(|el| el["description"] == "Click target").and_then(|el|el["ref"].as_str()).unwrap();
            let click = json!({"elementRef":button});
            call("web.session.click", click.clone()).await?;
            assert_eq!(page.evaluate("document.querySelector('button').innerText").await?, "Clicked");
            assert!(call("web.session.click", click).await.unwrap_err().to_string().contains("stale"));
            let current = call("web.session.snapshot", json!({"maxChars":1000})).await?;
            let input = current["data"]["elements"].as_array().unwrap().iter()
                .find(|el| el["description"] == "Plain input").unwrap();
            call("web.session.type", json!({"elementRef":input["ref"],"text":"exact value"})).await?;
            assert_eq!(page.evaluate("document.querySelector('input').value").await?, "exact value");

            call("web.session.pointer", json!({"action":"move","x":12,"y":20})).await?;
            let published = timeout(Duration::from_secs(5), cursor.wait_for(|event| event["sprite"].is_object() && event["position"].is_object())).await??.clone();
            assert_eq!(published["position"]["x"].as_f64(), Some(12.0 / 1280.0));
            assert_eq!(published["sprite"]["width"], 256);

            let drag = call("web.session.pointer", json!({
                "action":"drag","x":20,"y":45,"to":json!({"x":200,"y":45}),"durationMs":10000,
            }));
            let revoke = async {
                timeout(Duration::from_secs(3), async {
                    loop {
                        if page.evaluate("gesture.some(x=>x[0]==='mousedown')").await? == true {
                            lane.send_replace(true);
                            break Ok::<_,anyhow::Error>(());
                        }
                        sleep(Duration::from_millis(10)).await;
                    }
                }).await?
            };
            let (dragged, revoked) = tokio::join!(drag, revoke);
            revoked?;
            assert!(dragged.unwrap_err().to_string().contains("stopped with its agent turn"));
            assert_eq!(page.evaluate("gesture.filter(x=>x[0]==='mouseup').length").await?, json!(1));
            timeout(Duration::from_secs(3), cursor.wait_for(|event| event["position"].is_null())).await??;

            let (fresh_lane, fresh) = watch::channel(false);
            let denied = service.session_on_visible(&("other".into(),"chat".into()), &id, "web.session.snapshot", &json!({"maxChars":1000}), fresh.clone()).await;
            assert!(denied.unwrap_err().to_string().contains("another conversation"));
            let closed = service.session_on_visible(&scope, &id, "web.session.close", &json!({}), fresh.clone()).await?.unwrap();
            assert_eq!(closed["data"]["closed"], true);
            assert!(page.is_connected());
            let replaced = service.visible.records.lock().unwrap().get(&id).cloned();
            assert!(replaced.is_none());
            let replaced = opaque("wss")?;
            service.visible.records.lock().unwrap().insert(replaced.clone(), record);
            generation.send_replace(true);
            assert!(service.session_on_visible(&scope, &replaced, "web.session.snapshot", &json!({"maxChars":1000}), fresh).await.unwrap_err().to_string().contains("replaced or closed"));
            drop(fresh_lane);
            Ok(())
        }).await
    }).await
}
