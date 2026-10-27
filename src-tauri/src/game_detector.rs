use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsZoomed, ShowWindow, SW_HIDE,
    SW_SHOWNOACTIVATE,
};
use windows::Win32::Foundation::CloseHandle;

fn get_window_process_name(hwnd: HWND) -> Option<String> {
    unsafe {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;

        let res = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);

        if res.is_ok() && size > 0 {
            let full_path = String::from_utf16_lossy(&buf[..size as usize]);
            let file_name = full_path
                .rsplit(|c| c == '\\' || c == '/')
                .next()
                .unwrap_or(&full_path)
                .to_lowercase();
            return Some(file_name);
        }
    }
    None
}

fn is_known_non_game_process(proc: &str) -> bool {
    let non_games = [
        // Browsers
        "brave.exe", "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe",
        "vivaldi.exe", "arc.exe", "tor.exe", "waterfox.exe", "floorp.exe",
        // Developer & Terminal
        "code.exe", "cursor.exe", "devenv.exe", "idea64.exe", "pycharm64.exe",
        "webstorm64.exe", "sublime_text.exe", "windowsterminal.exe", "cmd.exe",
        "powershell.exe", "powershell_ise.exe", "bash.exe", "mintty.exe",
        "git-bash.exe", "alacritty.exe", "wezterm-gui.exe",
        // Productivity & Notes & Documents
        "notepad.exe", "notepad++.exe", "notion.exe", "obsidian.exe",
        "winword.exe", "excel.exe", "powerpnt.exe", "onenote.exe",
        "acrobat.exe", "acrord32.exe", "foxitpdf.exe",
        // Communication & Media
        "discord.exe", "spotify.exe", "slack.exe", "telegram.exe",
        "whatsapp.exe", "teams.exe", "thunderbird.exe", "vlc.exe",
        // Windows System & Shell
        "explorer.exe", "searchhost.exe", "shellexperiencehost.exe",
        "startmenuexperiencehost.exe", "applicationframehost.exe",
        "systemsettings.exe", "taskmgr.exe", "tauri-app.exe", "hermes.exe",
        "textinputhost.exe", "lockapp.exe", "screensketch.exe",
    ];
    non_games.iter().any(|&item| item == proc)
}

use crate::window_helper;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, TreeScope_Descendants, UIA_ControlTypePropertyId,
    UIA_TabItemControlTypeId, UIA_ButtonControlTypeId,
};
use windows::Win32::System::Variant::VARIANT;

/// Identifies if a foreground window (e.g. browser) has tabs extending behind or into the notch area
fn is_tab_behind_notch(
    automation: Option<&IUIAutomation>,
    notch_hwnd: HWND,
    settings_hwnd: Option<HWND>,
) -> bool {
    let auto = match automation {
        Some(a) => a,
        None => return false,
    };

    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg == notch_hwnd {
            return false;
        }
        if let Some(set_hw) = settings_hwnd {
            if fg == set_hw {
                return false;
            }
        }

        // Only check browsers for smart tab avoidance
        let proc = get_window_process_name(fg).unwrap_or_default();
        let is_browser = [
            "brave.exe", "chrome.exe", "msedge.exe", "firefox.exe",
            "opera.exe", "vivaldi.exe", "arc.exe", "tor.exe", "floorp.exe", "waterfox.exe"
        ].iter().any(|&b| b == proc);

        if !is_browser {
            return false;
        }

        // Filter Windows Shell & Desktop classes
        let mut class_buf = [0u16; 64];
        let len = GetClassNameW(fg, &mut class_buf);
        if len > 0 {
            let class_str = String::from_utf16_lossy(&class_buf[..len as usize]);
            if class_str == "Progman"
                || class_str == "WorkerW"
                || class_str == "Shell_TrayWnd"
                || class_str == "Shell_SecondaryTrayWnd"
                || class_str == "Windows.UI.Core.CoreWindow"
            {
                return false;
            }
        }

        // Check foreground window rect
        let mut fg_rect = RECT::default();
        if GetWindowRect(fg, &mut fg_rect).is_err() {
            return false;
        }

        let notch_hmon = MonitorFromWindow(notch_hwnd, MONITOR_DEFAULTTONULL);
        let fg_hmon = MonitorFromWindow(fg, MONITOR_DEFAULTTONULL);

        // Window must be on the SAME monitor as the Notch
        if fg_hmon.0.is_null() || fg_hmon != notch_hmon {
            return false;
        }

        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(notch_hmon, &mut mi).as_bool() {
            return false;
        }

        // Window must be attached to the top edge of the screen (maximized or top-snapped)
        let is_at_top = fg_rect.top <= mi.rcWork.top + 8;
        let center_x = (mi.rcMonitor.left + mi.rcMonitor.right) / 2;
        let spans_center = fg_rect.left <= center_x && fg_rect.right >= center_x;

        if !is_at_top || !spans_center {
            return false;
        }

        let notch_left = center_x - 175;
        let notch_right = center_x + 175;

        let var_tab = VARIANT::from(UIA_TabItemControlTypeId.0 as i32);
        let var_btn = VARIANT::from(UIA_ButtonControlTypeId.0 as i32);
        if let (Ok(c1), Ok(c2)) = (
            auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &var_tab),
            auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &var_btn),
        ) {
            if let Ok(cond) = auto.CreateOrCondition(&c1, &c2) {
                if let Ok(fg_elem) = auto.ElementFromHandle(fg) {
                    if let Ok(items) = fg_elem.FindAll(TreeScope_Descendants, &cond) {
                        if let Ok(count) = items.Length() {
                            for i in 0..count {
                                if let Ok(item) = items.GetElement(i) {
                                    if let Ok(item_rect) = item.CurrentBoundingRectangle() {
                                        // Header must be near the top edge of monitor
                                        if item_rect.top >= mi.rcMonitor.top - 10
                                            && item_rect.top <= mi.rcMonitor.top + 45
                                            && (item_rect.bottom - item_rect.top) >= 15
                                        {
                                            // Check if tab or new-tab button overlaps the notch area
                                            if item_rect.right >= notch_left && item_rect.left <= notch_right {
                                                return true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        false
    }
}

pub struct GameDetectorState {
    pub enabled: AtomicBool,
    pub configured_monitor: Mutex<Option<String>>,
    pub active_shifted_monitor: Mutex<Option<String>>,
}

impl Default for GameDetectorState {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(true),
            configured_monitor: Mutex::new(None),
            active_shifted_monitor: Mutex::new(None),
        }
    }
}

/// Identifies if a foreground window is currently occupying an entire monitor (fullscreen game)
fn get_fullscreen_monitor(
    notch_hwnd: HWND,
    settings_hwnd: Option<HWND>,
) -> Option<windows::Win32::Graphics::Gdi::HMONITOR> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg == notch_hwnd {
            return None;
        }
        if let Some(set_hw) = settings_hwnd {
            if fg == set_hw {
                return None;
            }
        }

        // 1. Process filter: If foreground is a known desktop/browser app, NEVER treat it as a game
        if let Some(proc_name) = get_window_process_name(fg) {
            if is_known_non_game_process(&proc_name) {
                return None;
            }
        }

        // 2. If window is standard maximized via title bar, it is a desktop app, NOT a fullscreen game
        if IsZoomed(fg).as_bool() {
            return None;
        }

        // 3. Filter desktop / shell processes
        let mut class_buf = [0u16; 64];
        let len = GetClassNameW(fg, &mut class_buf);
        if len > 0 {
            let class_str = String::from_utf16_lossy(&class_buf[..len as usize]);
            if class_str == "Progman"
                || class_str == "WorkerW"
                || class_str == "Shell_TrayWnd"
                || class_str == "Shell_SecondaryTrayWnd"
                || class_str == "Windows.UI.Core.CoreWindow"
            {
                return None;
            }
        }

        let mut fg_rect = RECT::default();
        if GetWindowRect(fg, &mut fg_rect).is_err() {
            return None;
        }

        let hmon = MonitorFromWindow(fg, MONITOR_DEFAULTTONULL);
        if hmon.0.is_null() {
            return None;
        }

        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
            return None;
        }

        let margin = 6;
        let is_fullscreen = fg_rect.left <= mi.rcMonitor.left + margin
            && fg_rect.top <= mi.rcMonitor.top + margin
            && fg_rect.right >= mi.rcMonitor.right - margin
            && fg_rect.bottom >= mi.rcMonitor.bottom - margin;

        if is_fullscreen {
            Some(hmon)
        } else {
            None
        }
    }
}

pub fn start_game_detector(app: AppHandle, state: Arc<GameDetectorState>) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let automation: Option<IUIAutomation> = unsafe {
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()
        };

        let mut currently_shifted: Option<String> = None;
        let mut currently_hidden = false;
        let mut was_smart_compact = false;
        let mut uncompact_counter = 0;
        let mut game_detect_counter = 0;
        let mut game_clear_counter = 0;

        loop {
            std::thread::sleep(std::time::Duration::from_millis(800));

            let main_win = match app.get_webview_window("main") {
                Some(w) => w,
                None => continue,
            };

            let notch_hwnd = match main_win.hwnd() {
                Ok(h) => HWND(h.0 as _),
                Err(_) => continue,
            };

            if !state.enabled.load(Ordering::Relaxed) {
                // If detector was just disabled while hidden/shifted, restore
                if currently_hidden {
                    unsafe {
                        let _ = ShowWindow(notch_hwnd, SW_SHOWNOACTIVATE);
                    }
                    currently_hidden = false;
                }
                if let Some(_) = currently_shifted.take() {
                    if let Ok(mut lock) = state.active_shifted_monitor.lock() {
                        *lock = None;
                    }
                    let cfg_mon = state.configured_monitor.lock().ok().and_then(|m| m.clone());
                    let dims = window_helper::get_responsive_dimensions(&main_win, cfg_mon.as_deref());
                    window_helper::reposition_notch(
                        &main_win,
                        dims.collapsed_width,
                        dims.collapsed_height,
                        cfg_mon.as_deref(),
                    );
                }
                game_detect_counter = 0;
                game_clear_counter = 0;
                continue;
            }

            let settings_hwnd = app
                .get_webview_window("settings")
                .and_then(|w| w.hwnd().ok())
                .map(|h| HWND(h.0 as _));

            let fullscreen_hmon = get_fullscreen_monitor(notch_hwnd, settings_hwnd);
            let available_monitors = main_win.available_monitors().unwrap_or_default();
            let configured_mon = state.configured_monitor.lock().ok().and_then(|m| m.clone());

            if let Some(hmon) = fullscreen_hmon {
                game_clear_counter = 0;
                game_detect_counter += 1;

                // Debounce: must detect genuine game for 2 consecutive ticks (~1.6s) before shifting
                if game_detect_counter >= 2 {
                    // Fullscreen game is active! Find which monitor it is on
                    let mut mi = MONITORINFO {
                        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                        ..Default::default()
                    };
                    unsafe {
                        let _ = GetMonitorInfoW(hmon, &mut mi);
                    }

                    // Match HMONITOR to Tauri Monitor by rect
                    let game_monitor = available_monitors.iter().find(|m| {
                        let pos = m.position();
                        pos.x == mi.rcMonitor.left && pos.y == mi.rcMonitor.top
                    });

                    let current_target_mon = window_helper::find_target_monitor(&main_win, configured_mon.as_deref());

                    let is_on_same_monitor = match (&game_monitor, &current_target_mon) {
                        (Some(gm), Some(tm)) => gm.name() == tm.name(),
                        _ => true,
                    };

                    if is_on_same_monitor {
                        // Game is running on the SAME monitor as the Notch!
                        if available_monitors.len() > 1 {
                            // Multi-monitor: Try shifting to another monitor that doesn't have the game
                            let other_monitor = available_monitors
                                .iter()
                                .find(|m| Some(m.name()) != game_monitor.map(|gm| gm.name()));

                            if let Some(target) = other_monitor {
                                if let Some(target_name) = target.name() {
                                    if currently_shifted.as_deref() != Some(target_name) {
                                        let dims = window_helper::get_responsive_dimensions(
                                            &main_win,
                                            Some(target_name),
                                        );
                                        window_helper::reposition_notch(
                                            &main_win,
                                            dims.collapsed_width,
                                            dims.collapsed_height,
                                            Some(target_name),
                                        );
                                        unsafe {
                                            let _ = ShowWindow(notch_hwnd, SW_SHOWNOACTIVATE);
                                        }
                                        currently_shifted = Some(target_name.to_string());
                                        if let Ok(mut lock) = state.active_shifted_monitor.lock() {
                                            *lock = Some(target_name.to_string());
                                        }
                                        currently_hidden = false;
                                        let _ = app.emit(
                                            "game-mode-status",
                                            serde_json::json!({
                                                "active": true,
                                                "shifted_to": target_name,
                                                "hidden": false
                                            }),
                                        );
                                    }
                                }
                            } else if !currently_hidden {
                                unsafe {
                                    let _ = ShowWindow(notch_hwnd, SW_HIDE);
                                }
                                currently_hidden = true;
                                let _ = app.emit(
                                    "game-mode-status",
                                    serde_json::json!({
                                        "active": true,
                                        "shifted_to": null,
                                        "hidden": true
                                    }),
                                );
                            }
                        } else if !currently_hidden {
                            // Single monitor: Hide notch completely while playing
                            unsafe {
                                let _ = ShowWindow(notch_hwnd, SW_HIDE);
                            }
                            currently_hidden = true;
                            let _ = app.emit(
                                "game-mode-status",
                                serde_json::json!({
                                    "active": true,
                                    "shifted_to": null,
                                    "hidden": true
                                }),
                            );
                        }
                    }
                }
            } else {
                game_detect_counter = 0;
                game_clear_counter += 1;

                // Debounce: must be clear for 2 ticks (~1.6s) before restoring
                if game_clear_counter >= 2 {
                    // No fullscreen game blocking the notch
                    if currently_hidden {
                        unsafe {
                            let _ = ShowWindow(notch_hwnd, SW_SHOWNOACTIVATE);
                        }
                        currently_hidden = false;
                        let _ = app.emit(
                            "game-mode-status",
                            serde_json::json!({
                                "active": false,
                                "shifted_to": null,
                                "hidden": false
                            }),
                        );
                    }

                    if let Some(_) = currently_shifted.take() {
                        if let Ok(mut lock) = state.active_shifted_monitor.lock() {
                            *lock = None;
                        }
                        // Restore back to user's configured monitor
                        let dims = window_helper::get_responsive_dimensions(
                            &main_win,
                            configured_mon.as_deref(),
                        );
                        window_helper::reposition_notch(
                            &main_win,
                            dims.collapsed_width,
                            dims.collapsed_height,
                            configured_mon.as_deref(),
                        );
                        let _ = app.emit(
                            "game-mode-status",
                            serde_json::json!({
                                "active": false,
                                "shifted_to": null,
                                "hidden": false
                            }),
                        );
                    }
                }

                // Smart Tab Avoidance check - only activates when tabs literally sit behind the notch
                let has_tabs_behind = is_tab_behind_notch(automation.as_ref(), notch_hwnd, settings_hwnd);
                if has_tabs_behind {
                    uncompact_counter = 0;
                    if !was_smart_compact {
                        was_smart_compact = true;
                        let _ = app.emit("smart-avoidance-status", serde_json::json!({ "compact": true }));
                    }
                } else if was_smart_compact {
                    uncompact_counter += 1;
                    if uncompact_counter >= 3 {
                        was_smart_compact = false;
                        uncompact_counter = 0;
                        let _ = app.emit("smart-avoidance-status", serde_json::json!({ "compact": false }));
                    }
                }
            }
        }
    });
}
