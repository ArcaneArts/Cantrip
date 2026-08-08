use tauri::Manager;

fn browser_webview(
    app: &tauri::AppHandle,
    label: &str,
) -> Result<tauri::Webview<tauri::Wry>, String> {
    if !label.starts_with("cantrip-browser-") {
        return Err("Invalid Cantrip browser webview label.".into());
    }
    app.get_webview(label)
        .ok_or_else(|| "Cantrip browser webview not found.".into())
}

#[tauri::command]
fn browser_webview_navigate(
    app: tauri::AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    let parsed = url
        .parse::<tauri::Url>()
        .map_err(|error| format!("Invalid browser URL: {error}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Cantrip browser navigation only supports HTTP and HTTPS.".into());
    }
    browser_webview(&app, &label)?
        .navigate(parsed)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn browser_webview_action(
    app: tauri::AppHandle,
    label: String,
    action: String,
) -> Result<(), String> {
    let webview = browser_webview(&app, &label)?;
    match action.as_str() {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => webview.reload(),
        _ => return Err("Unknown browser action.".into()),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn browser_webview_url(app: tauri::AppHandle, label: String) -> Result<String, String> {
    browser_webview(&app, &label)?
        .url()
        .map(|url| url.to_string())
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            browser_webview_action,
            browser_webview_navigate,
            browser_webview_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cantrip");
}
