use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{CloseHandle, HWND, POINT, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONULL,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Variant::VARIANT;
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, TreeScope_Children, TreeScope_Descendants,
    UIA_ControlTypePropertyId, UIA_TabControlTypeId, UIA_TabItemControlTypeId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetCursorPos, GetForegroundWindow, GetTopWindow, GetWindow, GetWindowLongW,
    GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
    IsZoomed, ShowWindow, GWL_STYLE, GW_HWNDNEXT, SW_HIDE, SW_SHOWNOACTIVATE, WS_CAPTION,
};

use crate::window_helper;

const QUNS_RUNNING_D3D_FULL_SCREEN: i32 = 3;
const QUNS_PRESENTATION_MODE: i32 = 4;

#[link(name = "shell32")]
unsafe extern "system" {
    fn SHQueryUserNotificationState(pquns: *mut i32) -> i32;
}

fn query_shell_fullscreen_state() -> bool {
    unsafe {
        let mut state: i32 = 0;
        if SHQueryUserNotificationState(&mut state) == 0 {
            state == QUNS_RUNNING_D3D_FULL_SCREEN || state == QUNS_PRESENTATION_MODE
        } else {
            false
        }
    }
}

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

fn is_browser_process(proc: &str) -> bool {
    matches!(
        proc,
        "brave.exe"
            | "chrome.exe"
            | "msedge.exe"
            | "firefox.exe"
            | "opera.exe"
            | "vivaldi.exe"
            | "arc.exe"
            | "tor.exe"
            | "waterfox.exe"
            | "floorp.exe"
            | "zen.exe"
    )
}

fn is_known_non_game_process(proc: &str) -> bool {
    if is_browser_process(proc) {
        return true;
    }
    let non_games = [
        // Developer & Terminal
        "code.exe",
        "cursor.exe",
        "devenv.exe",
        "idea64.exe",
        "pycharm64.exe",
        "webstorm64.exe",
        "sublime_text.exe",
        "windowsterminal.exe",
        "cmd.exe",
        "powershell.exe",
        "powershell_ise.exe",
        "bash.exe",
        "mintty.exe",
        "git-bash.exe",
        "alacritty.exe",
        "wezterm-gui.exe",
        // Productivity & Notes & Documents
        "notepad.exe",
        "notepad++.exe",
        "notion.exe",
        "obsidian.exe",
        "winword.exe",
        "excel.exe",
        "powerpnt.exe",
        "onenote.exe",
        "acrobat.exe",
        "acrord32.exe",
        "foxitpdf.exe",
        // Communication & Media
        "discord.exe",
        "spotify.exe",
        "slack.exe",
        "telegram.exe",
        "whatsapp.exe",
        "teams.exe",
        "thunderbird.exe",
        // Windows System & Shell
        "explorer.exe",
        "searchhost.exe",
        "shellexperiencehost.exe",
        "startmenuexperiencehost.exe",
        "applicationframehost.exe",
        "systemsettings.exe",
        "taskmgr.exe",
        "tauri-app.exe",
        "hermes.exe",
        "textinputhost.exe",
        "lockapp.exe",
        "screensketch.exe",
    ];
    non_games.iter().any(|&item| item == proc)
}

fn is_shell_window_class(hwnd: HWND) -> bool {
    unsafe {
        let mut class_buf = [0u16; 64];
        let len = GetClassNameW(hwnd, &mut class_buf);
        if len > 0 {
            let class_str = String::from_utf16_lossy(&class_buf[..len as usize]);
            return matches!(
                class_str.as_str(),
                "Progman"
                    | "WorkerW"
                    | "Shell_TrayWnd"
                    | "Shell_SecondaryTrayWnd"
                    | "Windows.UI.Core.CoreWindow"
                    | "XamlExplorerHostIslandWindow"
            );
        }
        false
    }
}

fn get_window_title_hash(hwnd: HWND) -> u64 {
    unsafe {
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, &mut buf);
        let mut hasher = DefaultHasher::new();
        hwnd.0.hash(&mut hasher);
        if len > 0 {
            buf[..len as usize].hash(&mut hasher);
        }
        hasher.finish()
    }
}

#[derive(Default)]
struct SmartTabCache {
    last_hwnd: Option<isize>,
    last_title_hash: u64,
    last_half_width: i32,
    last_result: bool,
    ticks_since_query: u32,
}

/// Walks Z-order to find the topmost visible window covering the top-center Notch area on `notch_hmon`.
/// If a small floating tool (e.g. Calculator/Notepad) is in the foreground at the center of the screen
/// without covering the top Notch strip, this skips past it and still detects the maximized browser behind the Notch.
fn find_topmost_browser_behind_notch(
    notch_hwnd: HWND,
    settings_hwnd: Option<HWND>,
    notch_hmon: HMONITOR,
    mi: &MONITORINFO,
) -> Option<HWND> {
    unsafe {
        let center_x = (mi.rcMonitor.left + mi.rcMonitor.right) / 2;
        let top_strip_y = mi.rcWork.top + 28;
        let mut curr = GetTopWindow(None).ok()?;
        let mut steps = 0;

        while !curr.0.is_null() && steps < 60 {
            steps += 1;
            let next = GetWindow(curr, GW_HWNDNEXT).ok();

            if curr == notch_hwnd || Some(curr) == settings_hwnd {
                curr = match next {
                    Some(n) => n,
                    None => break,
                };
                continue;
            }

            if !IsWindowVisible(curr).as_bool() || IsIconic(curr).as_bool() || is_shell_window_class(curr) {
                curr = match next {
                    Some(n) => n,
                    None => break,
                };
                continue;
            }

            let mut rect = RECT::default();
            if GetWindowRect(curr, &mut rect).is_ok() {
                let width = rect.right - rect.left;
                let height = rect.bottom - rect.top;
                if width > 120 && height > 80 {
                    let hmon = MonitorFromWindow(curr, MONITOR_DEFAULTTONULL);
                    if hmon == notch_hmon {
                        let covers_notch_zone = rect.top <= mi.rcWork.top + 10
                            && rect.bottom >= top_strip_y
                            && rect.left <= center_x
                            && rect.right >= center_x;

                        if covers_notch_zone {
                            let proc = get_window_process_name(curr).unwrap_or_default();
                            if is_browser_process(&proc) {
                                return Some(curr);
                            } else {
                                return None;
                            }
                        }
                    }
                }
            }

            curr = match next {
                Some(n) => n,
                None => break,
            };
        }
        None
    }
}

/// Identifies if a browser window has horizontal tabs extending behind or into the physical Notch area.
/// Uses Z-order detection, DPI-aware dynamic Notch bounds, TabStrip scoping, and title-hash caching.
fn is_tab_behind_notch(
    automation: Option<&IUIAutomation>,
    notch_hwnd: HWND,
    settings_hwnd: Option<HWND>,
    notch_half_width_phys: i32,
    scale_factor: f64,
    cache: &mut SmartTabCache,
) -> bool {
    let auto = match automation {
        Some(a) => a,
        None => return false,
    };

    unsafe {
        let notch_hmon = MonitorFromWindow(notch_hwnd, MONITOR_DEFAULTTONULL);
        if notch_hmon.0.is_null() {
            return false;
        }

        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(notch_hmon, &mut mi).as_bool() {
            return false;
        }

        let Some(browser_hwnd) =
            find_topmost_browser_behind_notch(notch_hwnd, settings_hwnd, notch_hmon, &mi)
        else {
            cache.last_hwnd = None;
            cache.last_result = false;
            return false;
        };

        let center_x = (mi.rcMonitor.left + mi.rcMonitor.right) / 2;
        let safety_pad = (14.0 * scale_factor).round() as i32;
        let notch_left = center_x - notch_half_width_phys - safety_pad;
        let notch_right = center_x + notch_half_width_phys + safety_pad;
        let max_tab_top = mi.rcMonitor.top + (52.0 * scale_factor).round() as i32;
        let max_tab_height = (56.0 * scale_factor).round() as i32;

        // Check if cursor is near the top tab bar (triggers immediate live check)
        let mut pt = POINT::default();
        let cursor_near_top = if GetCursorPos(&mut pt).is_ok() {
            pt.y >= mi.rcMonitor.top && pt.y <= max_tab_top + 12
        } else {
            false
        };

        let title_hash = get_window_title_hash(browser_hwnd);
        let hwnd_key = browser_hwnd.0 as isize;

        if cache.last_hwnd == Some(hwnd_key)
            && cache.last_title_hash == title_hash
            && cache.last_half_width == notch_half_width_phys
            && !cursor_near_top
            && cache.ticks_since_query < 6
        {
            cache.ticks_since_query += 1;
            return cache.last_result;
        }

        cache.last_hwnd = Some(hwnd_key);
        cache.last_title_hash = title_hash;
        cache.last_half_width = notch_half_width_phys;
        cache.ticks_since_query = 0;

        let var_tab_item = VARIANT::from(UIA_TabItemControlTypeId.0 as i32);
        let Ok(cond_tab_item) = auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &var_tab_item) else {
            return cache.last_result;
        };

        let Ok(fg_elem) = auto.ElementFromHandle(browser_hwnd) else {
            return cache.last_result;
        };

        // Scope search to the browser's TabStrip (UIA_TabControlTypeId) first so we never walk webpage DOMs
        let var_tab_strip = VARIANT::from(UIA_TabControlTypeId.0 as i32);
        let mut found_overlap = false;
        let mut checked_tab_strip = false;

        if let Ok(cond_strip) = auto.CreatePropertyCondition(UIA_ControlTypePropertyId, &var_tab_strip) {
            if let Ok(strips) = fg_elem.FindAll(TreeScope_Descendants, &cond_strip) {
                if let Ok(strip_count) = strips.Length() {
                    for s in 0..strip_count {
                        if let Ok(strip_el) = strips.GetElement(s) {
                            if let Ok(strip_rect) = strip_el.CurrentBoundingRectangle() {
                                // Only inspect horizontal tab strips near the top of the monitor (ignores vertical tab sidebars)
                                let strip_w = strip_rect.right - strip_rect.left;
                                let strip_h = strip_rect.bottom - strip_rect.top;
                                if strip_rect.top >= mi.rcMonitor.top - 12
                                    && strip_rect.top <= max_tab_top
                                    && strip_w > strip_h
                                {
                                    checked_tab_strip = true;
                                    if let Ok(items) = strip_el.FindAll(TreeScope_Children, &cond_tab_item) {
                                        let count = items.Length().unwrap_or(0);
                                        if count > 0 {
                                            for i in 0..count {
                                                if let Ok(item) = items.GetElement(i) {
                                                    if let Ok(r) = item.CurrentBoundingRectangle() {
                                                        if r.right >= notch_left && r.left <= notch_right {
                                                            found_overlap = true;
                                                            break;
                                                        }
                                                    }
                                                }
                                            }
                                        } else if let Ok(desc_items) =
                                            strip_el.FindAll(TreeScope_Descendants, &cond_tab_item)
                                        {
                                            let dcount = desc_items.Length().unwrap_or(0);
                                            for i in 0..dcount {
                                                if let Ok(item) = desc_items.GetElement(i) {
                                                    if let Ok(r) = item.CurrentBoundingRectangle() {
                                                        if r.right >= notch_left && r.left <= notch_right {
                                                            found_overlap = true;
                                                            break;
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    if found_overlap {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Fallback for browsers that don't wrap TabItems in a standard UIA_TabControlTypeId container
        if !checked_tab_strip && !found_overlap {
            if let Ok(items) = fg_elem.FindAll(TreeScope_Descendants, &cond_tab_item) {
                let count = items.Length().unwrap_or(0);
                for i in 0..count {
                    if let Ok(item) = items.GetElement(i) {
                        if let Ok(item_rect) = item.CurrentBoundingRectangle() {
                            let h = item_rect.bottom - item_rect.top;
                            if item_rect.top >= mi.rcMonitor.top - 10
                                && item_rect.top <= max_tab_top
                                && h >= 14
                                && h <= max_tab_height
                            {
                                if item_rect.right >= notch_left && item_rect.left <= notch_right {
                                    found_overlap = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        cache.last_result = found_overlap;
        found_overlap
    }
}

pub struct GameDetectorState {
    pub enabled: AtomicBool,
    pub smart_tab_enabled: AtomicBool,
    pub notch_base_width: AtomicU32,
    pub configured_monitor: Mutex<Option<String>>,
    pub active_shifted_monitor: Mutex<Option<String>>,
}

impl Default for GameDetectorState {
    fn default() -> Self {
        Self {
            enabled: AtomicBool::new(true),
            smart_tab_enabled: AtomicBool::new(true),
            notch_base_width: AtomicU32::new(210),
            configured_monitor: Mutex::new(None),
            active_shifted_monitor: Mutex::new(None),
        }
    }
}

fn is_rect_fullscreen_on_monitor(rect: &RECT, mi: &MONITORINFO) -> bool {
    let margin = 6;
    rect.left <= mi.rcMonitor.left + margin
        && rect.top <= mi.rcMonitor.top + margin
        && rect.right >= mi.rcMonitor.right - margin
        && rect.bottom >= mi.rcMonitor.bottom - margin
}

/// Hybrid Fullscreen Game & Media Detector:
/// 1. Uses native `SHQueryUserNotificationState` (`QUNS_RUNNING_D3D_FULL_SCREEN` / `QUNS_PRESENTATION_MODE`).
/// 2. Supports Borderless Windowed games even when Windows DWM marks them `IsZoomed`, by inspecting `WS_CAPTION`.
/// 3. Detects true F11 / Fullscreen Video in browsers when the window covers `rcMonitor` without a standard caption.
fn get_fullscreen_monitor(
    notch_hwnd: HWND,
    settings_hwnd: Option<HWND>,
) -> Option<(HMONITOR, HWND)> {
    unsafe {
        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg == notch_hwnd || Some(fg) == settings_hwnd {
            return None;
        }

        if is_shell_window_class(fg) || IsIconic(fg).as_bool() {
            return None;
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

        if !is_rect_fullscreen_on_monitor(&fg_rect, &mi) {
            return None;
        }

        let style = GetWindowLongW(fg, GWL_STYLE) as u32;
        let has_caption = (style & WS_CAPTION.0) == WS_CAPTION.0;
        let is_zoomed = IsZoomed(fg).as_bool();
        let shell_d3d_fullscreen = query_shell_fullscreen_state();
        let proc_name = get_window_process_name(fg).unwrap_or_default();

        if is_known_non_game_process(&proc_name) {
            // Allow browser/media true fullscreen (e.g. YouTube/Netflix F11) ONLY when borderless & not standard maximized
            let taskbar_visible_on_mon = (mi.rcMonitor.bottom - mi.rcWork.bottom).abs() > 12
                || (mi.rcMonitor.top - mi.rcWork.top).abs() > 12;
            let is_true_f11_fullscreen = is_browser_process(&proc_name)
                && !is_zoomed
                && (!has_caption || taskbar_visible_on_mon);

            if !is_true_f11_fullscreen {
                return None;
            }
        } else {
            // For unknown/game processes:
            // Standard maximized desktop utilities have both IsZoomed AND WS_CAPTION (and aren't D3D fullscreen).
            // Borderless Windowed games strip WS_CAPTION or trigger SHQueryUserNotificationState.
            if is_zoomed && has_caption && !shell_d3d_fullscreen {
                return None;
            }
        }

        Some((hmon, fg))
    }
}

/// Checks if a previously detected game window is still actively occupying its monitor in fullscreen.
/// Fixes the multi-monitor Alt-Tab stuck bug:
/// - If the user clicks an app on Monitor 2 while the game stays fullscreen on Monitor 1 -> returns `true`.
/// - If the user Alt-Tabs to another window ON the game monitor, or switches the game to windowed mode -> returns `false`.
fn is_previous_game_still_covering_monitor(
    game_hwnd: HWND,
    game_hmon: HMONITOR,
    notch_hwnd: HWND,
    settings_hwnd: Option<HWND>,
) -> bool {
    unsafe {
        if !IsWindow(Some(game_hwnd)).as_bool()
            || !IsWindowVisible(game_hwnd).as_bool()
            || IsIconic(game_hwnd).as_bool()
        {
            return false;
        }

        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(game_hmon, &mut mi).as_bool() {
            return false;
        }

        let mut game_rect = RECT::default();
        if GetWindowRect(game_hwnd, &mut game_rect).is_err() {
            return false;
        }

        if !is_rect_fullscreen_on_monitor(&game_rect, &mi) {
            return false;
        }

        let fg = GetForegroundWindow();
        if !fg.0.is_null() && fg != game_hwnd && fg != notch_hwnd && Some(fg) != settings_hwnd {
            if !is_shell_window_class(fg) {
                let fg_hmon = MonitorFromWindow(fg, MONITOR_DEFAULTTONULL);
                if fg_hmon == game_hmon {
                    return false;
                }
            }
        }

        true
    }
}

pub fn start_game_detector(app: AppHandle, state: Arc<GameDetectorState>) {
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let automation: Option<IUIAutomation> =
            unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok() };

        let mut currently_shifted: Option<String> = None;
        let mut currently_hidden = false;
        let mut was_smart_compact = false;
        let mut uncompact_counter = 0;
        let mut game_detect_counter = 0;
        let mut game_clear_counter = 0;
        let mut last_game_target: Option<(HWND, HMONITOR)> = None;
        let mut smart_tab_cache = SmartTabCache::default();

        loop {
            std::thread::sleep(std::time::Duration::from_millis(500));

            let main_win = match app.get_webview_window("main") {
                Some(w) => w,
                None => continue,
            };

            let notch_hwnd = match main_win.hwnd() {
                Ok(h) => HWND(h.0 as _),
                Err(_) => continue,
            };

            let settings_hwnd = app
                .get_webview_window("settings")
                .and_then(|w| w.hwnd().ok())
                .map(|h| HWND(h.0 as _));

            let game_mode_enabled = state.enabled.load(Ordering::Relaxed);
            let smart_tab_enabled = state.smart_tab_enabled.load(Ordering::Relaxed);
            let configured_mon = state.configured_monitor.lock().ok().and_then(|m| m.clone());

            // 1. GAME MODE & AUTO-AVOIDANCE
            if !game_mode_enabled {
                last_game_target = None;
                game_detect_counter = 0;
                game_clear_counter = 0;

                if currently_hidden {
                    unsafe {
                        let _ = ShowWindow(notch_hwnd, SW_SHOWNOACTIVATE);
                    }
                    currently_hidden = false;
                    let _ = app.emit(
                        "game-mode-status",
                        serde_json::json!({ "active": false, "shifted_to": null, "hidden": false }),
                    );
                }
                if currently_shifted.take().is_some() {
                    if let Ok(mut lock) = state.active_shifted_monitor.lock() {
                        *lock = None;
                    }
                    window_helper::reposition_notch(
                        &main_win,
                        window_helper::NOTCH_CANVAS_WIDTH,
                        window_helper::NOTCH_CANVAS_HEIGHT,
                        configured_mon.as_deref(),
                    );
                    let _ = app.emit(
                        "game-mode-status",
                        serde_json::json!({ "active": false, "shifted_to": null, "hidden": false }),
                    );
                }
            } else {
                let fullscreen_hmon = get_fullscreen_monitor(notch_hwnd, settings_hwnd);
                let available_monitors = main_win.available_monitors().unwrap_or_default();

                if let Some((hmon, game_hwnd)) = fullscreen_hmon {
                    last_game_target = Some((game_hwnd, hmon));
                    game_clear_counter = 0;
                    game_detect_counter += 1;

                    if game_detect_counter >= 2 {
                        let mut mi = MONITORINFO {
                            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
                            ..Default::default()
                        };
                        unsafe {
                            let _ = GetMonitorInfoW(hmon, &mut mi);
                        }

                        let game_monitor = available_monitors.iter().find(|m| {
                            let pos = m.position();
                            pos.x == mi.rcMonitor.left && pos.y == mi.rcMonitor.top
                        });

                        let current_target_mon =
                            window_helper::find_target_monitor(&main_win, configured_mon.as_deref());

                        let is_on_same_monitor = match (&game_monitor, &current_target_mon) {
                            (Some(gm), Some(tm)) => gm.name() == tm.name(),
                            _ => true,
                        };

                        if is_on_same_monitor {
                            if available_monitors.len() > 1 {
                                let other_monitor = available_monitors
                                    .iter()
                                    .find(|m| Some(m.name()) != game_monitor.map(|gm| gm.name()));

                                if let Some(target) = other_monitor {
                                    if let Some(target_name) = target.name() {
                                        if currently_shifted.as_deref() != Some(target_name) {
                                            let _ = app.emit(
                                                "game-mode-will-shift",
                                                serde_json::json!({ "target": target_name }),
                                            );
                                            std::thread::sleep(std::time::Duration::from_millis(180));

                                            window_helper::reposition_notch(
                                                &main_win,
                                                window_helper::NOTCH_CANVAS_WIDTH,
                                                window_helper::NOTCH_CANVAS_HEIGHT,
                                                Some(target_name),
                                            );
                                            unsafe {
                                                let _ = ShowWindow(notch_hwnd, SW_SHOWNOACTIVATE);
                                            }
                                            currently_shifted = Some(target_name.to_string());
                                            if let Ok(mut lock) = state.active_shifted_monitor.lock()
                                            {
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
                    let is_game_still_active =
                        if let Some((ghwnd, ghmon)) = last_game_target {
                            is_previous_game_still_covering_monitor(
                                ghwnd,
                                ghmon,
                                notch_hwnd,
                                settings_hwnd,
                            )
                        } else {
                            false
                        };

                    if is_game_still_active {
                        game_clear_counter = 0;
                    } else {
                        last_game_target = None;
                        game_detect_counter = 0;
                        game_clear_counter += 1;

                        if game_clear_counter >= 2 {
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

                            if currently_shifted.take().is_some() {
                                if let Ok(mut lock) = state.active_shifted_monitor.lock() {
                                    *lock = None;
                                }
                                let _ = app.emit("game-mode-will-restore", ());
                                std::thread::sleep(std::time::Duration::from_millis(180));

                                window_helper::reposition_notch(
                                    &main_win,
                                    window_helper::NOTCH_CANVAS_WIDTH,
                                    window_helper::NOTCH_CANVAS_HEIGHT,
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
                    }
                }
            }

            // 2. SMART TAB AVOIDANCE (independent from Game Mode toggle)
            if !smart_tab_enabled {
                if was_smart_compact {
                    was_smart_compact = false;
                    uncompact_counter = 0;
                    let _ = app.emit(
                        "smart-avoidance-status",
                        serde_json::json!({ "compact": false }),
                    );
                }
                continue;
            }

            let scale = main_win.scale_factor().unwrap_or(1.0);
            let base_w_logical = state.notch_base_width.load(Ordering::Relaxed).max(150) as f64;
            let half_w_phys = ((base_w_logical * scale) / 2.0).round() as i32;

            let has_tabs_behind = if !currently_hidden {
                is_tab_behind_notch(
                    automation.as_ref(),
                    notch_hwnd,
                    settings_hwnd,
                    half_w_phys,
                    scale,
                    &mut smart_tab_cache,
                )
            } else {
                false
            };

            if has_tabs_behind {
                uncompact_counter = 0;
                if !was_smart_compact {
                    was_smart_compact = true;
                    let _ = app.emit(
                        "smart-avoidance-status",
                        serde_json::json!({ "compact": true }),
                    );
                }
            } else if was_smart_compact {
                uncompact_counter += 1;
                if uncompact_counter >= 1 {
                    was_smart_compact = false;
                    uncompact_counter = 0;
                    let _ = app.emit(
                        "smart-avoidance-status",
                        serde_json::json!({ "compact": false }),
                    );
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_fullscreen_and_process_classifiers() {
        let _ = query_shell_fullscreen_state();
        assert!(is_browser_process("brave.exe"));
        assert!(is_browser_process("msedge.exe"));
        assert!(!is_browser_process("valorant-win64-shipping.exe"));
        assert!(is_known_non_game_process("code.exe"));
        assert!(!is_known_non_game_process("cs2.exe"));
    }
}
