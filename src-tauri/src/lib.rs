mod game_detector;
mod media;
mod queue_server;
mod window_helper;

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

#[tauri::command]
fn get_notch_config(
    app: AppHandle,
    state: tauri::State<Arc<game_detector::GameDetectorState>>,
    target_monitor: Option<String>,
) -> window_helper::NotchDimensions {
    if let Some(target) = &target_monitor {
        if let Ok(mut lock) = state.configured_monitor.lock() {
            *lock = Some(target.clone());
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        window_helper::get_responsive_dimensions(&window, target_monitor.as_deref())
    } else {
        window_helper::NotchDimensions {
            collapsed_width: 210.0,
            collapsed_height: 36.0,
            expanded_width: 420.0,
            expanded_height: 205.0,
            lyrics_height: 300.0,
        }
    }
}

#[tauri::command]
fn set_notch_state(app: AppHandle, expanded: bool, target_monitor: Option<String>) {
    if let Some(window) = app.get_webview_window("main") {
        let dims = window_helper::get_responsive_dimensions(&window, target_monitor.as_deref());
        let (w, h) = if expanded {
            (dims.expanded_width, dims.expanded_height)
        } else {
            (dims.collapsed_width, dims.collapsed_height)
        };
        window_helper::reposition_notch(&window, w, h, target_monitor.as_deref());
    }
}

#[tauri::command]
fn set_notch_size(
    app: AppHandle,
    state: tauri::State<Arc<game_detector::GameDetectorState>>,
    width: f64,
    height: f64,
    target_monitor: Option<String>,
) {
    if let Some(target) = &target_monitor {
        if let Ok(mut lock) = state.configured_monitor.lock() {
            *lock = Some(target.clone());
        }
    }
    // Respect temporary game mode shift if active
    let effective_monitor = if let Ok(lock) = state.active_shifted_monitor.lock() {
        lock.clone().or(target_monitor)
    } else {
        target_monitor
    };

    if let Some(window) = app.get_webview_window("main") {
        window_helper::reposition_notch(&window, width, height, effective_monitor.as_deref());
    }
}

#[tauri::command]
fn get_available_monitors(app: AppHandle) -> Vec<window_helper::MonitorOption> {
    if let Some(window) = app.get_webview_window("main") {
        window_helper::get_monitor_options(&window)
    } else {
        vec![]
    }
}

#[tauri::command]
fn get_media_track() -> Result<media::MediaTrackInfo, String> {
    media::get_current_media_track().map_err(|e| e.to_string())
}

#[tauri::command]
fn media_toggle_play() -> Result<(), String> {
    media::media_play_pause().map_err(|e| e.to_string())
}

#[tauri::command]
fn media_next_track() -> Result<(), String> {
    media::media_next().map_err(|e| e.to_string())
}

#[tauri::command]
fn media_prev_track() -> Result<(), String> {
    media::media_previous().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_game_mode(state: tauri::State<Arc<game_detector::GameDetectorState>>, enabled: bool) {
    state.enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if window.label() == "settings" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window_helper::setup_notch_window(&window);
            }

            let game_detector_state = Arc::new(game_detector::GameDetectorState::default());
            app.manage(game_detector_state.clone());
            game_detector::start_game_detector(app.handle().clone(), game_detector_state);

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    if let Ok(info) = media::get_current_media_track() {
                        let _ = app_handle.emit("media-status", info);
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            });

            // Start Spicetify local queue server
            queue_server::start_queue_server(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notch_config,
            set_notch_state,
            set_notch_size,
            get_available_monitors,
            set_game_mode,
            get_media_track,
            media_toggle_play,
            media_next_track,
            media_prev_track,
            open_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
