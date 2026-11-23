use super::*;
use std::collections::HashSet;

fn file(view: &Value, dock: &Value) -> Value {
    let resource =
        json!({"kind":"entity","definitionId":"project.file","resourceId":view["documentId"]});
    json!({"id":view["tabId"],"resource":resource,"preview":false,"fileMode":view["mode"],"titleProtection":Value::Null,"builtInState":Value::Null,"dockPresentation":dock})
}
pub(super) fn apply(state: &mut Command, action: &Value) -> Result<()> {
    let (mut pane, mut tab) = tab_by_id(&state.window, &action["tabId"])?;
    if action["type"] == "migrate-code-files" {
        if tab["resource"]["kind"] != "entity"
            || tab["resource"]["definitionId"] != "project.code"
            || tab["resource"]["resourceId"] != action["codeId"]
        {
            return Err(invalid("Legacy Code binding changed."));
        }
        let receipt = json!({"tabId":tab["id"],"codeId":action["codeId"],"views":action["views"]});
        if let Some(prior) = values(&state.layout, "legacyCodeImports")
            .iter()
            .find(|r| r["tabId"] == tab["id"])
        {
            if prior.stringify() != receipt.stringify() {
                return Err(invalid("Code conversion receipt does not match."));
            }
            return Ok(());
        }
        if state.reserved(&tab["id"]) {
            return Err(invalid("Legacy view is reserved for a pending transfer."));
        }
        let all = state.all_tabs();
        let mut occupied = all
            .iter()
            .map(|t| t["id"].as_js_string().unwrap().clone())
            .collect::<HashSet<_>>();
        let mut documents = all
            .iter()
            .filter(|t| {
                t["resource"]["kind"] == "entity" && t["resource"]["definitionId"] == "project.file"
            })
            .map(|t| t["resource"]["resourceId"].as_js_string().unwrap().clone())
            .collect::<HashSet<_>>();
        for view in values(action, "views") {
            if occupied.contains(view["tabId"].as_js_string().unwrap())
                || documents.contains(view["documentId"].as_js_string().unwrap())
            {
                return Err(invalid(
                    "Migration view or document identity is already in use.",
                ));
            }
            occupied.insert(view["tabId"].as_js_string().unwrap().clone());
            documents.insert(view["documentId"].as_js_string().unwrap().clone());
        }
        let files = values(action, "views")
            .iter()
            .map(|view| file(view, &tab["dockPresentation"]))
            .collect::<Vec<_>>();
        let index = values(&pane, "tabs")
            .iter()
            .position(|t| t["id"] == tab["id"])
            .unwrap();
        tabs(&mut pane).splice(index + 1..index + 1, files.clone());
        let active = pane["activeTabId"] == tab["id"];
        let focused = state.window["focusedPaneId"] == pane["id"];
        if active {
            pane["activeTabId"] = files[0]["id"].clone();
        }
        let pane_id = pane["id"].clone();
        store_pane(&mut state.window, pane);
        if active && focused {
            focus(&mut state.window, &pane_id, &files[0]["id"]);
        }
        let mut receipts = values(&state.layout, "legacyCodeImports").to_vec();
        receipts.push(receipt);
        state.layout["legacyCodeImports"] = Value::Array(receipts);
    } else {
        if tab["resource"]["kind"] != "entity"
            || tab["resource"]["definitionId"] != "project.explorer"
            || tab["resource"]["resourceId"] != action["explorerId"]
        {
            return Err(invalid("Legacy Explorer binding changed."));
        }
        if state.reserved(&tab["id"]) {
            return Err(invalid("Legacy view is reserved for a pending transfer."));
        }
        let mut occupied = state
            .all_tabs()
            .iter()
            .map(|t| t["id"].as_js_string().unwrap().clone())
            .collect::<HashSet<_>>();
        let mut documents = HashSet::from([action["documentId"].as_js_string().unwrap().clone()]);
        for view in values(action, "retainedViews") {
            if occupied.contains(view["tabId"].as_js_string().unwrap())
                || documents.contains(view["documentId"].as_js_string().unwrap())
            {
                return Err(invalid(
                    "Migration view or document identity is already in use.",
                ));
            }
            occupied.insert(view["tabId"].as_js_string().unwrap().clone());
            documents.insert(view["documentId"].as_js_string().unwrap().clone());
        }
        tab["resource"] = json!({"kind":"entity","definitionId":"project.file","resourceId":action["documentId"]});
        tab["fileMode"] = action["mode"].clone();
        tab["titleProtection"] = Value::Null;
        let retained = values(action, "retainedViews")
            .iter()
            .map(|view| file(view, &tab["dockPresentation"]))
            .collect::<Vec<_>>();
        let index = values(&pane, "tabs")
            .iter()
            .position(|t| t["id"] == tab["id"])
            .unwrap();
        tabs(&mut pane)[index] = tab;
        tabs(&mut pane).splice(index + 1..index + 1, retained);
        store_pane(&mut state.window, pane);
    }
    Ok(())
}
