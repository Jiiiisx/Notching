mod media;
mod window_helper;

use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
fn get_notch_config(app: AppHandle) -> window_helper::NotchDimensions {
    if let Some(window) = app.get_webview_window("main") {
        window_helper::get_responsive_dimensions(&window)
    } else {
        window_helper::NotchDimensions {
            collapsed_width: 180.0,
            collapsed_height: 36.0,
            expanded_width: 420.0,
            expanded_height: 205.0,
            lyrics_height: 300.0,
        }
    }
}

#[tauri::command]
fn set_notch_state(app: AppHandle, expanded: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let dims = window_helper::get_responsive_dimensions(&window);
        let (w, h) = if expanded {
            (dims.expanded_width, dims.expanded_height)
        } else {
            (dims.collapsed_width, dims.collapsed_height)
        };
        window_helper::reposition_notch(&window, w, h);
    }
}

#[tauri::command]
fn set_notch_size(app: AppHandle, width: f64, height: f64) {
    if let Some(window) = app.get_webview_window("main") {
        window_helper::reposition_notch(&window, width, height);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                window_helper::setup_notch_window(&window);
            }

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    if let Ok(info) = media::get_current_media_track() {
                        let _ = app_handle.emit("media-status", info);
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notch_config,
            set_notch_state,
            set_notch_size,
            get_media_track,
            media_toggle_play,
            media_next_track,
            media_prev_track
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
