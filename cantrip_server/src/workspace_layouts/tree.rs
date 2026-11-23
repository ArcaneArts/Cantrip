use crate::wire::Value;

pub(super) fn remove_leaf(node: &Value, pane: &Value) -> Value {
    if node.is_null() {
        return Value::Null;
    }
    if node["kind"] == "pane" {
        return if node["paneId"] == *pane {
            Value::Null
        } else {
            node.clone()
        };
    }
    let first = remove_leaf(&node["first"], pane);
    let second = remove_leaf(&node["second"], pane);
    if first.is_null() {
        return second;
    }
    if second.is_null() {
        return first;
    }
    let mut result = node.clone();
    result["first"] = first;
    result["second"] = second;
    result
}

pub(super) fn replace_leaf(node: &Value, pane: &Value, replacement: &Value) -> Value {
    if node["kind"] == "pane" {
        return if node["paneId"] == *pane {
            replacement.clone()
        } else {
            node.clone()
        };
    }
    let mut result = node.clone();
    result["first"] = replace_leaf(&node["first"], pane, replacement);
    result["second"] = replace_leaf(&node["second"], pane, replacement);
    result
}

pub(super) fn resize(node: &mut Value, id: &Value, fraction: &Value) -> bool {
    if node.is_null() || node["kind"] == "pane" {
        return false;
    }
    if node["id"] == *id {
        node["fraction"] = fraction.clone();
        return true;
    }
    resize(&mut node["first"], id, fraction) || resize(&mut node["second"], id, fraction)
}

pub(super) fn reorder(node: &mut Value, ids: &[Value], at: &mut usize) {
    if node["kind"] == "pane" {
        node["paneId"] = ids[*at].clone();
        *at += 1;
    } else {
        reorder(&mut node["first"], ids, at);
        reorder(&mut node["second"], ids, at);
    }
}
