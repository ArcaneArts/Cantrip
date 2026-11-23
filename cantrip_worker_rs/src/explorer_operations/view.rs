use cantrip_wire::{JsString, Value, value::json};

pub fn directory_page(directory: &Value, cursor: usize, limit: usize) -> Value {
    let entries = directory["entries"]
        .as_array()
        .expect("validated Explorer entries");
    let page: Vec<_> = entries.iter().skip(cursor).take(limit).cloned().collect();
    let next = (cursor + page.len() < entries.len()).then_some(cursor + page.len());
    json!({
        "path":directory["path"],"entries":page,"cursor":cursor,"nextCursor":next,
        "total":entries.len(),"truncated":directory["truncated"] == true || next.is_some(),
    })
}

pub fn text_preview(mut file: Value, maximum: usize) -> (Value, Value) {
    let content = file["content"]
        .as_js_string()
        .expect("validated Explorer file content");
    let truncated = content.len() > maximum;
    let suffix = if truncated {
        file["content"] = json!(JsString::new(content.units()[..maximum].to_vec()));
        " (content truncated)."
    } else {
        "."
    };
    file["truncated"] = json!(truncated);
    (file_summary("Read ", &file["path"], suffix), file)
}

pub fn file_summary(prefix: &str, path: &Value, suffix: &str) -> Value {
    let path = path.as_js_string().expect("validated Explorer file path");
    json!(JsString::new(
        prefix
            .encode_utf16()
            .chain(path.units().iter().copied())
            .chain(suffix.encode_utf16())
            .collect()
    ))
}
