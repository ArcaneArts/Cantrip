use std::{fs, path::PathBuf, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder as PluginBuilder, TauriPlugin},
    AppHandle, Manager, Monitor, PhysicalPosition, PhysicalSize, RunEvent, Runtime, WebviewWindow,
};

const PLACEMENT_SCHEMA_VERSION: u8 = 1;
const PLACEMENT_FILENAME: &str = ".main-window-placement.json";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorIdentity {
    name: Option<String>,
    width: u32,
    height: u32,
    scale_millis: u32,
    x: i32,
    y: i32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedPlacement {
    schema_version: u8,
    monitor: MonitorIdentity,
    logical_offset_x: f64,
    logical_offset_y: f64,
}

#[derive(Clone, Debug, PartialEq)]
struct MonitorGeometry {
    identity: MonitorIdentity,
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
}

struct PlacementState(Mutex<Option<SavedPlacement>>);

fn scale_millis(scale_factor: f64) -> u32 {
    (scale_factor.max(0.001) * 1_000.0).round() as u32
}

fn geometry(monitor: &Monitor) -> MonitorGeometry {
    let position = monitor.position();
    let size = monitor.size();
    let work_area = monitor.work_area();
    MonitorGeometry {
        identity: MonitorIdentity {
            name: monitor.name().cloned(),
            width: size.width,
            height: size.height,
            scale_millis: scale_millis(monitor.scale_factor()),
            x: position.x,
            y: position.y,
        },
        work_x: work_area.position.x,
        work_y: work_area.position.y,
        work_width: work_area.size.width,
        work_height: work_area.size.height,
    }
}

fn monitor_distance(saved: &MonitorIdentity, candidate: &MonitorIdentity) -> u64 {
    let resolution = saved.width.abs_diff(candidate.width) as u64
        + saved.height.abs_diff(candidate.height) as u64;
    let scale = saved.scale_millis.abs_diff(candidate.scale_millis) as u64;
    let position = saved.x.abs_diff(candidate.x) as u64 + saved.y.abs_diff(candidate.y) as u64;
    resolution
        .saturating_mul(1_000_000)
        .saturating_add(scale.saturating_mul(10_000))
        .saturating_add(position)
}

fn select_monitor<'a>(
    saved: &MonitorIdentity,
    monitors: &'a [MonitorGeometry],
) -> Option<&'a MonitorGeometry> {
    let candidates = monitors.iter().filter(|candidate| match &saved.name {
        Some(name) => candidate.identity.name.as_ref() == Some(name),
        None => {
            candidate.identity.name.is_none()
                && candidate.identity.width == saved.width
                && candidate.identity.height == saved.height
                && candidate.identity.scale_millis == saved.scale_millis
        }
    });
    candidates.min_by_key(|candidate| monitor_distance(saved, &candidate.identity))
}

fn clamp_axis(desired: i64, start: i32, available: u32, window: u32) -> i32 {
    let start = i64::from(start);
    let max = start + i64::from(available.saturating_sub(window.min(available)));
    desired.clamp(start, max) as i32
}

fn restored_position(
    placement: &SavedPlacement,
    monitor: &MonitorGeometry,
    window_size: PhysicalSize<u32>,
) -> PhysicalPosition<i32> {
    let scale = f64::from(monitor.identity.scale_millis) / 1_000.0;
    let x = i64::from(monitor.work_x) + (placement.logical_offset_x * scale).round() as i64;
    let y = i64::from(monitor.work_y) + (placement.logical_offset_y * scale).round() as i64;
    PhysicalPosition::new(
        clamp_axis(x, monitor.work_x, monitor.work_width, window_size.width),
        clamp_axis(y, monitor.work_y, monitor.work_height, window_size.height),
    )
}

fn placement_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(PLACEMENT_FILENAME))
        .map_err(|error| error.to_string())
}

fn load_placement<R: Runtime>(app: &AppHandle<R>) -> Option<SavedPlacement> {
    let path = placement_path(app).ok()?;
    let bytes = fs::read(path).ok()?;
    let placement: SavedPlacement = serde_json::from_slice(&bytes).ok()?;
    (placement.schema_version == PLACEMENT_SCHEMA_VERSION
        && placement.logical_offset_x.is_finite()
        && placement.logical_offset_y.is_finite())
    .then_some(placement)
}

fn write_placement<R: Runtime>(
    app: &AppHandle<R>,
    placement: &SavedPlacement,
) -> Result<(), String> {
    let path = placement_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Window placement path has no parent directory.".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(placement).map_err(|error| error.to_string())?;
    fs::write(path, bytes).map_err(|error| error.to_string())
}

fn capture_placement<R: Runtime>(
    window: &WebviewWindow<R>,
    previous: Option<SavedPlacement>,
) -> Result<Option<SavedPlacement>, String> {
    let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    else {
        return Ok(previous);
    };
    let monitor = geometry(&monitor);
    if window.is_maximized().unwrap_or(false) || window.is_minimized().unwrap_or(false) {
        return Ok(Some(SavedPlacement {
            schema_version: PLACEMENT_SCHEMA_VERSION,
            monitor: monitor.identity,
            logical_offset_x: previous
                .as_ref()
                .map_or(0.0, |placement| placement.logical_offset_x),
            logical_offset_y: previous
                .as_ref()
                .map_or(0.0, |placement| placement.logical_offset_y),
        }));
    }
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let scale = f64::from(monitor.identity.scale_millis) / 1_000.0;
    Ok(Some(SavedPlacement {
        schema_version: PLACEMENT_SCHEMA_VERSION,
        monitor: monitor.identity,
        logical_offset_x: f64::from(position.x - monitor.work_x) / scale,
        logical_offset_y: f64::from(position.y - monitor.work_y) / scale,
    }))
}

pub(crate) fn save<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let state = window.state::<PlacementState>();
    let mut placement = state.0.lock().unwrap_or_else(|error| error.into_inner());
    let captured = capture_placement(window, placement.clone())?;
    let Some(captured) = captured else {
        return Ok(());
    };
    write_placement(window.app_handle(), &captured)?;
    *placement = Some(captured);
    Ok(())
}

fn restore<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let state = window.state::<PlacementState>();
    let placement = state
        .0
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let Some(placement) = placement else {
        return Ok(());
    };
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?
        .iter()
        .map(geometry)
        .collect::<Vec<_>>();
    let Some(monitor) = select_monitor(&placement.monitor, &monitors) else {
        return Ok(());
    };
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized {
        window.unmaximize().map_err(|error| error.to_string())?;
    }
    let position = restored_position(
        &placement,
        monitor,
        window.outer_size().map_err(|error| error.to_string())?,
    );
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;
    if maximized {
        window.maximize().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(crate) fn plugin<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("cantrip-window-placement")
        .setup(|app, _api| {
            let placement = load_placement(app);
            app.manage(PlacementState(Mutex::new(placement)));
            Ok(())
        })
        .on_window_ready(|window| {
            if window.label() == "main" {
                if let Some(window) = window.app_handle().get_webview_window("main") {
                    let _ = restore(&window);
                }
            }
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = save(&window);
                }
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::{
        restored_position, select_monitor, MonitorGeometry, MonitorIdentity, SavedPlacement,
    };
    use tauri::PhysicalSize;

    fn monitor(name: Option<&str>, x: i32, width: u32, scale_millis: u32) -> MonitorGeometry {
        MonitorGeometry {
            identity: MonitorIdentity {
                name: name.map(str::to_string),
                width,
                height: 1_440,
                scale_millis,
                x,
                y: 0,
            },
            work_x: x,
            work_y: 24,
            work_width: width,
            work_height: 1_380,
        }
    }

    fn placement(monitor: &MonitorGeometry, x: f64, y: f64) -> SavedPlacement {
        SavedPlacement {
            schema_version: 1,
            monitor: monitor.identity.clone(),
            logical_offset_x: x,
            logical_offset_y: y,
        }
    }

    #[test]
    fn named_monitor_survives_display_rearrangement() {
        let saved = monitor(Some("Studio Display"), 2_560, 2_560, 2_000);
        let monitors = [
            monitor(Some("Built-in Retina Display"), 2_560, 3_024, 2_000),
            monitor(Some("Studio Display"), 0, 2_560, 2_000),
        ];

        assert_eq!(
            select_monitor(&saved.identity, &monitors),
            Some(&monitors[1])
        );
    }

    #[test]
    fn duplicate_monitor_names_prefer_saved_geometry() {
        let saved = monitor(Some("Generic Display"), 1_920, 2_560, 1_000);
        let monitors = [
            monitor(Some("Generic Display"), 0, 1_920, 1_000),
            monitor(Some("Generic Display"), -2_560, 2_560, 1_000),
        ];

        assert_eq!(
            select_monitor(&saved.identity, &monitors),
            Some(&monitors[1])
        );
    }

    #[test]
    fn display_relative_position_scales_and_stays_on_screen() {
        let saved_monitor = monitor(Some("Studio Display"), 2_560, 2_560, 1_000);
        let destination = monitor(Some("Studio Display"), -3_840, 3_840, 2_000);
        let saved = placement(&saved_monitor, 200.0, 100.0);

        assert_eq!(
            restored_position(&saved, &destination, PhysicalSize::new(1_280, 800)),
            tauri::PhysicalPosition::new(-3_440, 224)
        );

        let offscreen = placement(&saved_monitor, 9_999.0, 9_999.0);
        assert_eq!(
            restored_position(&offscreen, &destination, PhysicalSize::new(1_280, 800)),
            tauri::PhysicalPosition::new(-1_280, 604)
        );
    }
}
