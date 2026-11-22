use super::{Request, opaque, render};
use anyhow::{Context, Result, bail, ensure};
use cantrip_browser::{Page, Subscription};
use cantrip_wire::{JsString, Value, value::json};
use std::{collections::HashMap, time::Duration};
use tokio::time::{Instant, sleep_until, timeout_at};
use url::Url;

const SELECTOR: &str = "a,button,input,textarea,select,[role=button],[tabindex]";
const MAX_ELEMENTS: usize = 100;
const MAX_SNAPSHOT: usize = 50_000;
const ELEMENT_OBJECTS: &str = "cantrip-web-session-elements";
const ACTION_TIMEOUT: Duration = Duration::from_secs(15);
const ACTION_RETRY: Duration = Duration::from_millis(20);
const MAX_ACTION_RETRY: Duration = Duration::from_millis(250);
const CLICK_UNAVAILABLE: &str = "The web element is no longer visible or enabled.";
const FILL_UNAVAILABLE: &str = "The web element is no longer editable.";
const STALE_ELEMENT: &str = "The web element reference is stale; take a fresh session snapshot.";
const IS_DISABLED: &str = r#"function (element) {
    if (element.matches(':disabled')) return true;
    const role = element.getAttribute('role')?.trim().split(/\s+/)[0]?.toLowerCase();
    const inherit = element.matches('a[href],button,input,option,optgroup,select,textarea') || [
        'application', 'button', 'checkbox', 'columnheader', 'combobox', 'composite',
        'grid', 'gridcell', 'group', 'input', 'link', 'listbox', 'menu', 'menubar',
        'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup',
        'row', 'rowheader', 'scrollbar', 'searchbox', 'select', 'separator', 'slider',
        'spinbutton', 'switch', 'tab', 'tablist', 'textbox', 'toolbar', 'tree',
        'treegrid', 'treeitem'
    ].includes(role);
    for (let node = element; node; node = node.parentElement ?? node.getRootNode().host) {
        const state = node.getAttribute('aria-disabled')?.toLowerCase();
        if (state === 'true' || state === 'false') return state === 'true';
        if (!inherit) break;
    }
    return false;
}"#;

pub(super) struct State {
    generation: u64,
    snapshot: Option<Snapshot>,
}

struct Snapshot {
    text: JsString,
    elements: Vec<Value>,
    nodes: HashMap<String, u64>,
    loader: JsString,
}

impl Default for State {
    fn default() -> Self {
        Self {
            generation: 1,
            snapshot: None,
        }
    }
}

impl State {
    pub(super) async fn execute(
        &mut self,
        page: &Page,
        policy: &render::Policy,
        id: &str,
        request: Request,
    ) -> Result<Value> {
        match request {
            Request::Navigate(target) => {
                self.invalidate();
                render::navigate(page, policy, &target).await?;
            }
            Request::Snapshot(maximum) => return self.snapshot(page, id, maximum).await,
            Request::Click(reference) => {
                let node = self.element(page, &reference).await?;
                self.invalidate();
                let before = frame_loader(page).await?;
                let mut events = page.subscribe();
                let _ = policy.take_failure();
                click(page, node).await?;
                settle_navigation(page, policy, &mut events, &before).await?;
            }
            Request::Type(reference, text, submit) => {
                let node = self.element(page, &reference).await?;
                self.invalidate();
                let before = frame_loader(page).await?;
                let mut events = page.subscribe();
                let _ = policy.take_failure();
                fill(page, node, text, submit).await?;
                if submit {
                    settle_navigation(page, policy, &mut events, &before).await?;
                }
            }
            Request::Close => unreachable!("close is owned by the browser session"),
        }
        state(page, id, self.generation).await
    }

    fn invalidate(&mut self) {
        self.generation += 1;
        self.snapshot = None;
    }

    async fn snapshot(&mut self, page: &Page, id: &str, maximum: usize) -> Result<Value> {
        let loader = frame_loader(page).await?;
        if self
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.loader != loader)
        {
            self.invalidate();
        }
        let snapshot = match &self.snapshot {
            Some(snapshot) => snapshot,
            None => self.snapshot.insert(capture(page, loader).await?),
        };
        let chars = snapshot.text.units();
        let mut result = state(page, id, self.generation).await?;
        result["snapshot"] = json!(JsString::new(chars[..maximum.min(chars.len())].to_vec()));
        result["elements"] = json!(snapshot.elements);
        result["truncated"] = json!(chars.len() > maximum);
        Ok(result)
    }

    async fn element(&mut self, page: &Page, reference: &str) -> Result<u64> {
        let loader = frame_loader(page).await?;
        if self
            .snapshot
            .as_ref()
            .is_some_and(|snapshot| snapshot.loader != loader)
        {
            self.invalidate();
        }
        self.snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.nodes.get(reference))
            .copied()
            .context(STALE_ELEMENT)
    }
}

pub(super) async fn state(page: &Page, id: &str, generation: u64) -> Result<Value> {
    let context = render::isolated_world(page).await?;
    let result = page
        .evaluate_in(
            "({url:document.URL,title:document.title.slice(0,1000)})",
            Some(context),
        )
        .await?;
    let url = super::normalize(Url::parse(
        result["url"]
            .as_str()
            .context("The browser has no active document.")?,
    )?)?;
    Ok(
        json!({"sessionId":id,"generation":generation,"url":url.as_str(),"title":result["title"],"persistent":false}),
    )
}

async fn frame_loader(page: &Page) -> Result<JsString> {
    let tree = page.request("Page.getFrameTree", json!({})).await?;
    tree["frameTree"]["frame"]["loaderId"]
        .as_js_string()
        .cloned()
        .context("Chromium did not report a document loader.")
}

async fn capture(page: &Page, loader: JsString) -> Result<Snapshot> {
    let data = page
        .request("Accessibility.getFullAXTree", json!({}))
        .await?;
    let entries = data["nodes"]
        .as_array()
        .context("Chromium returned no accessibility snapshot.")?;
    let labels: HashMap<u64, &Value> = entries
        .iter()
        .filter_map(|node| {
            (node["ignored"] != true).then_some(())?;
            Some((node["backendDOMNodeId"].as_u64()?, node))
        })
        .collect();
    let mut snapshot = Snapshot {
        text: describe_tree(entries),
        elements: Vec::new(),
        nodes: HashMap::new(),
        loader,
    };
    let nodes = interactive_nodes(page).await;
    let _ = page
        .request(
            "Runtime.releaseObjectGroup",
            json!({"objectGroup":ELEMENT_OBJECTS}),
        )
        .await;
    for backend in nodes? {
        let description = labels.get(&backend).map_or_else(
            || JsString::from("interactive element"),
            |node| super::super::compact(&description(node), 500),
        );
        let reference = opaque("wer")?;
        snapshot.nodes.insert(reference.clone(), backend);
        snapshot
            .elements
            .push(json!({"ref":reference,"description":description}));
    }
    ensure!(
        frame_loader(page).await? == snapshot.loader,
        "The page changed during its snapshot; take a fresh session snapshot."
    );
    Ok(snapshot)
}

async fn interactive_nodes(page: &Page) -> Result<Vec<u64>> {
    let context = render::isolated_world(page).await?;
    let expression = format!(
        r#"(() => {{
        const elements = [];
        const pending = document.documentElement ? [document.documentElement] : [];
        while (pending.length && elements.length < {MAX_ELEMENTS}) {{
            const element = pending.pop();
            if (element.matches({selector})) elements.push(element);
            // Visit each host's light children before its open shadow children.
            if (element.nextElementSibling) pending.push(element.nextElementSibling);
            const shadowChild = element.shadowRoot?.firstElementChild;
            if (shadowChild) pending.push(shadowChild);
            if (element.firstElementChild) pending.push(element.firstElementChild);
        }}
        return elements;
    }})()"#,
        selector = json!(SELECTOR).stringify()
    );
    let result = page
        .request(
            "Runtime.evaluate",
            json!({
                "expression":expression,"contextId":context,"objectGroup":ELEMENT_OBJECTS,
                "returnByValue":false,
            }),
        )
        .await?;
    let array = result["result"]["objectId"]
        .as_js_string()
        .context("Chromium did not return the interactive elements.")?;
    let properties = page
        .request(
            "Runtime.getProperties",
            json!({"objectId":array,"ownProperties":true}),
        )
        .await?;
    let elements = properties["result"]
        .as_array()
        .context("Chromium did not report the interactive elements.")?;
    let mut nodes = Vec::new();
    for element in elements
        .iter()
        .filter(|property| property["name"] != "length")
        .take(MAX_ELEMENTS)
    {
        let object = element["value"]["objectId"]
            .as_js_string()
            .context("Chromium could not resolve the interactive element.")?;
        let described = page
            .request("DOM.describeNode", json!({"objectId":object,"depth":0}))
            .await?;
        nodes.push(
            described["node"]["backendNodeId"]
                .as_u64()
                .context("Chromium could not identify the interactive element.")?,
        );
    }
    Ok(nodes)
}

fn description(node: &Value) -> String {
    let role = match node["role"]["value"].as_str() {
        Some("StaticText") => "text",
        Some("RootWebArea") => "document",
        Some(role) if !role.is_empty() => role,
        _ => "generic",
    };
    let name = node["name"]["value"]
        .as_js_string()
        .filter(|name| !name.is_empty());
    let mut text = role.to_owned();
    if let Some(name) = name {
        text.push(' ');
        let name = JsString::new(
            name.units()
                .iter()
                .copied()
                .take(MAX_SNAPSHOT + 1)
                .collect(),
        );
        text.push_str(&json!(name).stringify());
    }
    if let Some(properties) = node["properties"].as_array() {
        for property in properties {
            let attribute = property["name"].as_str().unwrap_or("");
            let value = &property["value"]["value"];
            if attribute == "level"
                && let Some(level) = value.as_u64()
            {
                text.push_str(&format!(" [level={level}]"));
            } else if matches!(
                attribute,
                "checked" | "disabled" | "expanded" | "selected" | "pressed"
            ) {
                if *value == true || *value == "true" {
                    text.push_str(&format!(" [{attribute}]"));
                } else if *value == "mixed" {
                    text.push_str(&format!(" [{attribute}=mixed]"));
                }
            }
        }
    }
    if let Some(value) = node["value"]["value"]
        .as_js_string()
        .filter(|value| !value.is_empty())
    {
        text.push_str(": ");
        let value = JsString::new(
            value
                .units()
                .iter()
                .copied()
                .take(MAX_SNAPSHOT + 1)
                .collect(),
        );
        text.push_str(&json!(value).stringify());
    }
    text
}

fn describe_tree(nodes: &[Value]) -> JsString {
    let by_id: HashMap<&JsString, &Value> = nodes
        .iter()
        .filter_map(|node| Some((node["nodeId"].as_js_string()?, node)))
        .collect();
    let mut pending: Vec<_> = nodes
        .iter()
        .filter(|node| !node["parentId"].is_string())
        .rev()
        .map(|node| (node, 0_usize))
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    while let Some((node, depth)) = pending.pop() {
        if !seen.insert(node["nodeId"].as_js_string()) {
            continue;
        }
        let role = node["role"]["value"].as_str().unwrap_or("");
        let render = node["ignored"] != true
            && !matches!(role, "InlineTextBox" | "none" | "RootWebArea")
            && !(role == "generic"
                && node["name"]["value"]
                    .as_js_string()
                    .is_none_or(JsString::is_empty));
        if render {
            if !result.is_empty() {
                result.push(u16::from(b'\n'));
            }
            result.extend(std::iter::repeat_n(u16::from(b' '), depth.min(30) * 2));
            result.extend("- ".encode_utf16());
            result.extend(
                description(node)
                    .encode_utf16()
                    .take(MAX_SNAPSHOT + 1 - result.len().min(MAX_SNAPSHOT + 1)),
            );
            if result.len() > MAX_SNAPSHOT {
                result.truncate(MAX_SNAPSHOT + 1);
                break;
            }
        }
        if let Some(children) = node["childIds"].as_array() {
            pending.extend(children.iter().rev().filter_map(|child| {
                by_id
                    .get(child.as_js_string()?)
                    .map(|node| (*node, depth + usize::from(render)))
            }));
        }
    }
    JsString::new(result)
}

async fn call_dom(page: &Page, node: u64, function: &str, arguments: &[Value]) -> Result<Value> {
    let world = render::isolated_world(page).await?;
    let resolved = page
        .request(
            "DOM.resolveNode",
            json!({"backendNodeId":node,"executionContextId":world}),
        )
        .await
        .context(STALE_ELEMENT)?;
    let object = resolved["object"]["objectId"]
        .as_js_string()
        .context("Chromium could not resolve the interactive element.")?;
    let result = page
        .request(
            "Runtime.callFunctionOn",
            json!({
                "objectId":object,"functionDeclaration":function,"arguments":arguments,
                "returnByValue":true,
            }),
        )
        .await;
    let _ = page
        .request("Runtime.releaseObject", json!({"objectId":object}))
        .await;
    let result = result?;
    ensure!(
        result.get("exceptionDetails").is_none(),
        "The web element could not be used."
    );
    Ok(result["result"]["value"].clone())
}

fn action_function(function: &str) -> String {
    format!(
        "function (...args) {{ const isDisabled = {IS_DISABLED}; return ({function}).apply(this, args); }}"
    )
}

async fn wait_for_action(
    page: &Page,
    node: u64,
    function: &str,
    arguments: &[Value],
    require_stability: bool,
    unavailable: &str,
    deadline: Instant,
) -> Result<Value> {
    let mut retry = ACTION_RETRY;
    let mut previous = Value::Null;
    while Instant::now() < deadline {
        // A null result reports a temporary condition before the action can proceed.
        let result = call_dom(page, node, function, arguments).await?;
        ensure!(result != "stale", "{STALE_ELEMENT}");
        if !result.is_null() && (!require_stability || result == previous) {
            return Ok(result);
        }
        previous = result;
        sleep_until((Instant::now() + retry).min(deadline)).await;
        retry = (retry * 2).min(MAX_ACTION_RETRY);
    }
    bail!("{unavailable}");
}

async fn click(page: &Page, node: u64) -> Result<()> {
    let locate = action_function(
        r#"function (point) {
        if (!this.isConnected || this.ownerDocument !== document) return 'stale';
        if (isDisabled(this) || getComputedStyle(this).visibility !== 'visible') return null;
        if (!point) this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        const rect = this.getBoundingClientRect();
        const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
        const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
        if (left >= right || top >= bottom) return null;
        const x = point?.x ?? (left + right) / 2, y = point?.y ?? (top + bottom) / 2;
        if (x < left || x >= right || y < top || y >= bottom) return null;
        let hit = document.elementFromPoint(x,y);
        while (hit?.shadowRoot) {
            const root = hit.shadowRoot;
            const inner = root.elementFromPoint(x,y);
            if (!inner || !(root.contains(inner) || root.contains(inner.assignedSlot))) break;
            hit = inner;
        }
        while (hit) {
            if (hit === this) return {x,y,bounds:[rect.left,rect.top,rect.width,rect.height]};
            hit = hit.assignedSlot ?? hit.parentElement ?? hit.getRootNode().host;
        }
        return null;
    }"#,
    );
    let deadline = Instant::now() + ACTION_TIMEOUT;
    let point = loop {
        let point =
            wait_for_action(page, node, &locate, &[], true, CLICK_UNAVAILABLE, deadline).await?;
        ensure!(
            point["x"].as_f64().is_some() && point["y"].as_f64().is_some(),
            "{CLICK_UNAVAILABLE}"
        );
        mouse_event(page, "mouseMoved", &point).await?;
        // Hover handlers can move or cover the target before the press.
        let hit = call_dom(page, node, &locate, &[json!({"value":point})]).await?;
        ensure!(hit != "stale", "{STALE_ELEMENT}");
        if hit == point {
            break point;
        }
    };
    mouse_event(page, "mousePressed", &point).await?;
    mouse_event(page, "mouseReleased", &point).await
}

async fn mouse_event(page: &Page, kind: &str, point: &Value) -> Result<()> {
    let moving = kind == "mouseMoved";
    page.request(
        "Input.dispatchMouseEvent",
        json!({
            "type":kind,"x":point["x"],"y":point["y"],
            "button":if moving { "none" } else { "left" },
            "clickCount":if moving { 0 } else { 1 },
        }),
    )
    .await?;
    Ok(())
}

async fn fill(page: &Page, node: u64, text: Value, submit: bool) -> Result<()> {
    let prepared = wait_for_action(
        page,
        node,
        &action_function(r#"function (text) {
        if (!this.isConnected || this.ownerDocument !== document) return 'stale';
        // A focusable label child can represent its associated form control.
        const interactive = this.isContentEditable || this.matches('a,[role=link],input,textarea,select') ||
            this.closest('button,[role=button],[role=checkbox],[role=radio]');
        const target = interactive ? this : (this.closest('label')?.control ?? this);
        if (!target.isConnected || target.ownerDocument !== document) return 'stale';
        const type = target instanceof HTMLInputElement ? target.type : null;
        const nativeValue = ['color','date','time','datetime-local','month','range','week'].includes(type);
        const textInput = ['text','search','url','tel','email','password','number'].includes(type);
        const textarea = target instanceof HTMLTextAreaElement;
        if (!(nativeValue || textInput || textarea || (type === null && target.isContentEditable))) return 'unsupported';
        if (!this.getClientRects().length || getComputedStyle(this).visibility !== 'visible' ||
            !target.getClientRects().length || getComputedStyle(target).visibility !== 'visible' ||
            target.readOnly || isDisabled(target)) return null;
        if (type === 'number' && Number.isNaN(Number(text.trim()))) return 'invalid-number';
        target.focus();
        const active = target.getRootNode().activeElement;
        if (active !== target && !target.contains(active)) return 'unfocused';
        if (nativeValue) {
            const value = type === 'color' ? text.trim().toLowerCase() : text.trim();
            target.value = value;
            if (target.value !== value) return 'malformed';
            target.dispatchEvent(new Event('input', {bubbles:true,composed:true}));
            target.dispatchEvent(new Event('change', {bubbles:true}));
            return 'set';
        }
        if (textInput || textarea) target.select();
        else {
            const range = document.createRange();
            range.selectNodeContents(target);
            const selection = getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }
        return 'keyboard';
    }"#),
        &[json!({"value":text})],
        false,
        FILL_UNAVAILABLE,
        Instant::now() + ACTION_TIMEOUT,
    )
    .await?;
    match prepared.as_str() {
        Some("set") => {}
        Some("keyboard") => {
            if text.as_js_string().is_some_and(JsString::is_empty) {
                key(page, "Delete", 46).await?;
            } else {
                page.request("Input.insertText", json!({"text":text}))
                    .await?;
            }
        }
        Some("invalid-number") => bail!("Cannot type text into input[type=number]"),
        Some("malformed") => bail!("Malformed value"),
        _ => bail!("{FILL_UNAVAILABLE}"),
    }
    if submit {
        let focused = call_dom(
            page,
            node,
            "function () { if (!this.isConnected) return false; this.focus(); return true; }",
            &[],
        )
        .await?;
        ensure!(focused == true, "The web element is no longer available.");
        key(page, "Enter", 13).await?;
    }
    Ok(())
}

async fn key(page: &Page, key: &str, code: u64) -> Result<()> {
    for kind in ["keyDown", "keyUp"] {
        page.request(
            "Input.dispatchKeyEvent",
            json!({
                "type":kind,"key":key,"code":key,"windowsVirtualKeyCode":code,
                "text":if kind == "keyDown" && key == "Enter" { "\r" } else { "" },
            }),
        )
        .await?;
    }
    Ok(())
}

async fn settle_navigation(
    page: &Page,
    policy: &render::Policy,
    events: &mut Subscription,
    before: &JsString,
) -> Result<()> {
    let mut deadline = Instant::now() + Duration::from_millis(200);
    let mut navigating = false;
    while let Ok(event) = timeout_at(deadline, events.next()).await {
        let event = event?;
        let params = event.params();
        if event.method() == "Page.lifecycleEvent"
            && params["frameId"].as_js_string() == Some(policy.frame())
            && params["name"] == "DOMContentLoaded"
            && params["loaderId"].as_js_string() != Some(before)
        {
            return Ok(());
        }
        let began = match event.method() {
            "Page.frameStartedLoading" => params["frameId"].as_js_string() == Some(policy.frame()),
            "Page.frameNavigated" => params["frame"]["id"].as_js_string() == Some(policy.frame()),
            _ => false,
        };
        if began && !navigating {
            navigating = true;
            deadline = Instant::now() + Duration::from_secs(5);
        }
        if let Some(failure) = policy.take_failure() {
            bail!(failure);
        }
    }
    if let Some(failure) = policy.take_failure() {
        bail!(failure);
    }
    if navigating && frame_loader(page).await? == *before {
        bail!("Chromium did not finish the web session navigation.");
    }
    Ok(())
}
