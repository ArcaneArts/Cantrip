use std::{collections::HashMap, sync::Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State, WebviewWindow};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalRect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalTabSlot {
    tab_key: String,
    left: f64,
    right: f64,
}

#[derive(Debug, Clone)]
struct PhysicalRect {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl PhysicalRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.left && x <= self.right && y >= self.top && y <= self.bottom
    }
}

#[derive(Debug, Clone)]
struct PhysicalTabSlot {
    _tab_key: String,
    left: f64,
    right: f64,
}

#[derive(Debug, Clone)]
struct TopBarRegistration {
    group_id: String,
    project_id: String,
    rect: PhysicalRect,
    registration_id: String,
    tabs: Vec<PhysicalTabSlot>,
    window_label: String,
}

#[derive(Debug, Clone)]
struct ActiveTabDrag {
    source_group_id: String,
    source_project_id: String,
    _source_tab_key: String,
    source_window_label: String,
}

#[derive(Default)]
struct CoordinatorInner {
    active_drag: Option<ActiveTabDrag>,
    top_bars: HashMap<String, TopBarRegistration>,
}

#[derive(Default)]
pub struct WindowCoordinator(Mutex<CoordinatorInner>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPosition {
    x: f64,
    y: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDragStart {
    mode: &'static str,
    source_window_label: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum NativeDropResolution {
    Cancelled,
    Detach {
        screen_x: f64,
        screen_y: f64,
    },
    Dock {
        target_group_id: String,
        target_member_position: usize,
        target_project_id: String,
        target_window_label: String,
    },
    Invalid {
        reason: String,
    },
    Noop,
}

fn physical_rect(origin_x: f64, origin_y: f64, scale: f64, rect: &LogicalRect) -> PhysicalRect {
    PhysicalRect {
        left: origin_x + rect.left * scale,
        top: origin_y + rect.top * scale,
        right: origin_x + rect.right * scale,
        bottom: origin_y + rect.bottom * scale,
    }
}

fn member_position(slots: &[PhysicalTabSlot], cursor_x: f64) -> usize {
    slots
        .iter()
        .position(|slot| cursor_x < (slot.left + slot.right) / 2.0)
        .unwrap_or(slots.len())
}

fn resolve_drop(
    active_drag: &ActiveTabDrag,
    registrations: &[TopBarRegistration],
    cursor_x: f64,
    cursor_y: f64,
) -> NativeDropResolution {
    let mut targets = registrations
        .iter()
        .filter(|registration| registration.rect.contains(cursor_x, cursor_y))
        .collect::<Vec<_>>();
    targets
        .sort_by_key(|registration| registration.window_label == active_drag.source_window_label);
    let Some(target) = targets.first() else {
        return NativeDropResolution::Detach {
            screen_x: cursor_x,
            screen_y: cursor_y,
        };
    };
    if target.project_id != active_drag.source_project_id {
        return NativeDropResolution::Invalid {
            reason: "Tab groups cannot span projects.".to_owned(),
        };
    }
    if target.group_id == active_drag.source_group_id {
        return NativeDropResolution::Noop;
    }
    NativeDropResolution::Dock {
        target_group_id: target.group_id.clone(),
        target_member_position: member_position(&target.tabs, cursor_x),
        target_project_id: target.project_id.clone(),
        target_window_label: target.window_label.clone(),
    }
}

#[tauri::command]
pub fn register_tab_top_bar(
    window: WebviewWindow,
    coordinator: State<'_, WindowCoordinator>,
    project_id: String,
    group_id: String,
    registration_id: String,
    rect: LogicalRect,
    tabs: Vec<LogicalTabSlot>,
) -> Result<(), String> {
    let origin = window
        .inner_position()
        .map_err(|error| format!("Could not read window position: {error}"))?;
    let scale = window
        .scale_factor()
        .map_err(|error| format!("Could not read window scale factor: {error}"))?;
    let origin_x = f64::from(origin.x);
    let origin_y = f64::from(origin.y);
    let registration = TopBarRegistration {
        group_id,
        project_id,
        rect: physical_rect(origin_x, origin_y, scale, &rect),
        registration_id,
        tabs: tabs
            .into_iter()
            .map(|slot| PhysicalTabSlot {
                _tab_key: slot.tab_key,
                left: origin_x + slot.left * scale,
                right: origin_x + slot.right * scale,
            })
            .collect(),
        window_label: window.label().to_owned(),
    };
    coordinator
        .0
        .lock()
        .map_err(|_| "The desktop window coordinator is unavailable.".to_owned())?
        .top_bars
        .insert(window.label().to_owned(), registration);
    Ok(())
}

#[tauri::command]
pub fn unregister_tab_top_bar(
    window: WebviewWindow,
    coordinator: State<'_, WindowCoordinator>,
    registration_id: String,
) -> Result<(), String> {
    let mut inner = coordinator
        .0
        .lock()
        .map_err(|_| "The desktop window coordinator is unavailable.".to_owned())?;
    if inner
        .top_bars
        .get(window.label())
        .is_some_and(|registration| registration.registration_id == registration_id)
    {
        inner.top_bars.remove(window.label());
    }
    Ok(())
}

#[tauri::command]
pub fn begin_native_tab_drag(
    window: WebviewWindow,
    coordinator: State<'_, WindowCoordinator>,
    project_id: String,
    group_id: String,
    tab_key: String,
    source_group_size: usize,
    source_is_popout: bool,
) -> Result<NativeDragStart, String> {
    let source_window_label = window.label().to_owned();
    coordinator
        .0
        .lock()
        .map_err(|_| "The desktop window coordinator is unavailable.".to_owned())?
        .active_drag = Some(ActiveTabDrag {
        source_group_id: group_id,
        source_project_id: project_id,
        _source_tab_key: tab_key,
        source_window_label: source_window_label.clone(),
    });
    Ok(NativeDragStart {
        mode: if source_is_popout && source_group_size == 1 {
            "move-window"
        } else {
            "preview"
        },
        source_window_label,
    })
}

#[tauri::command]
pub fn native_tab_drag_cursor(window: WebviewWindow) -> Result<CursorPosition, String> {
    let cursor = window
        .cursor_position()
        .map_err(|error| format!("Could not read the pointer position: {error}"))?;
    Ok(CursorPosition {
        x: cursor.x,
        y: cursor.y,
    })
}

#[tauri::command]
pub fn cancel_native_tab_drag(coordinator: State<'_, WindowCoordinator>) -> Result<(), String> {
    coordinator
        .0
        .lock()
        .map_err(|_| "The desktop window coordinator is unavailable.".to_owned())?
        .active_drag = None;
    Ok(())
}

#[tauri::command]
pub fn finish_native_tab_drag(
    window: WebviewWindow,
    coordinator: State<'_, WindowCoordinator>,
) -> Result<NativeDropResolution, String> {
    let cursor = window
        .cursor_position()
        .map_err(|error| format!("Could not read the pointer position: {error}"))?;
    let (active_drag, registrations) = {
        let mut inner = coordinator
            .0
            .lock()
            .map_err(|_| "The desktop window coordinator is unavailable.".to_owned())?;
        (inner.active_drag.take(), inner.top_bars.clone())
    };
    let Some(active_drag) = active_drag else {
        return Ok(NativeDropResolution::Cancelled);
    };

    let targets = registrations
        .values()
        .filter(|registration| {
            window
                .app_handle()
                .get_webview_window(&registration.window_label)
                .is_some()
        })
        .cloned()
        .collect::<Vec<_>>();
    Ok(resolve_drop(&active_drag, &targets, cursor.x, cursor.y))
}

#[cfg(test)]
mod tests {
    use super::{
        member_position, physical_rect, resolve_drop, ActiveTabDrag, LogicalRect,
        NativeDropResolution, PhysicalRect, PhysicalTabSlot, TopBarRegistration,
    };

    fn registration(
        window_label: &str,
        project_id: &str,
        group_id: &str,
        left: f64,
        right: f64,
    ) -> TopBarRegistration {
        TopBarRegistration {
            group_id: group_id.into(),
            project_id: project_id.into(),
            rect: PhysicalRect {
                left,
                top: 0.0,
                right,
                bottom: 40.0,
            },
            registration_id: "registration".into(),
            tabs: vec![PhysicalTabSlot {
                _tab_key: "terminal:target".into(),
                left,
                right,
            }],
            window_label: window_label.into(),
        }
    }

    fn active_drag() -> ActiveTabDrag {
        ActiveTabDrag {
            source_group_id: "group-source".into(),
            source_project_id: "project-1".into(),
            _source_tab_key: "chat:source".into(),
            source_window_label: "source-window".into(),
        }
    }

    #[test]
    fn converts_logical_rectangles_with_negative_monitor_origins() {
        let rect = physical_rect(
            -1920.0,
            80.0,
            2.0,
            &LogicalRect {
                left: 10.0,
                top: 5.0,
                right: 210.0,
                bottom: 45.0,
            },
        );
        assert_eq!(rect.left, -1900.0);
        assert_eq!(rect.top, 90.0);
        assert_eq!(rect.right, -1500.0);
        assert_eq!(rect.bottom, 170.0);
        assert!(rect.contains(-1700.0, 100.0));
    }

    #[test]
    fn inserts_before_the_tab_whose_midpoint_follows_the_pointer() {
        let slots = vec![
            PhysicalTabSlot {
                _tab_key: "chat:a".into(),
                left: 100.0,
                right: 200.0,
            },
            PhysicalTabSlot {
                _tab_key: "terminal:b".into(),
                left: 200.0,
                right: 320.0,
            },
        ];
        assert_eq!(member_position(&slots, 120.0), 0);
        assert_eq!(member_position(&slots, 180.0), 1);
        assert_eq!(member_position(&slots, 400.0), 2);
        assert_eq!(slots[0]._tab_key, "chat:a");
    }

    #[test]
    fn docks_into_another_registered_window_and_ignores_the_overlapping_source() {
        let resolution = resolve_drop(
            &active_drag(),
            &[
                registration("source-window", "project-1", "group-source", 0.0, 300.0),
                registration("target-window", "project-1", "group-target", 0.0, 300.0),
            ],
            200.0,
            20.0,
        );
        assert!(matches!(
            resolution,
            NativeDropResolution::Dock {
                target_group_id,
                target_member_position: 1,
                target_window_label,
                ..
            } if target_group_id == "group-target" && target_window_label == "target-window"
        ));
    }

    #[test]
    fn treats_the_source_bar_as_a_noop_and_empty_space_as_detach() {
        let source = registration("source-window", "project-1", "group-source", 0.0, 300.0);
        assert!(matches!(
            resolve_drop(&active_drag(), std::slice::from_ref(&source), 100.0, 20.0),
            NativeDropResolution::Noop
        ));
        assert!(matches!(
            resolve_drop(&active_drag(), &[source], -1400.0, 900.0),
            NativeDropResolution::Detach {
                screen_x: -1400.0,
                screen_y: 900.0
            }
        ));
    }

    #[test]
    fn rejects_cross_project_window_docking() {
        let target = registration("target-window", "project-2", "group-target", 0.0, 300.0);
        assert!(matches!(
            resolve_drop(&active_drag(), &[target], 100.0, 20.0),
            NativeDropResolution::Invalid { .. }
        ));
    }
}
