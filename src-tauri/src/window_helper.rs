use serde::{Deserialize, Serialize};
use tauri::{LogicalPosition, LogicalSize, WebviewWindow};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, GWL_STYLE,
    HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOSENDCHANGING, SWP_NOZORDER, WS_CAPTION, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW, WS_POPUP, WS_THICKFRAME,
};

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct NotchDimensions {
    pub collapsed_width: f64,
    pub collapsed_height: f64,
    pub expanded_width: f64,
    pub expanded_height: f64,
    pub lyrics_height: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MonitorOption {
    pub id: String,
    pub label: String,
    pub is_primary: bool,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

pub fn find_target_monitor(
    window: &WebviewWindow,
    target_id: Option<&str>,
) -> Option<tauri::Monitor> {
    let monitors = window.available_monitors().ok().unwrap_or_default();
    if monitors.is_empty() {
        return window.primary_monitor().ok().flatten();
    }

    if let Some(tid) = target_id {
        if !tid.is_empty() && tid != "primary" {
            if let Some(m) = monitors.iter().find(|m| {
                m.name().is_some_and(|n| {
                    n == tid
                        || n.trim_start_matches(r"\\.\") == tid.trim_start_matches(r"\\.\")
                        || n.replace('\\', "") == tid.replace('\\', "")
                })
            }) {
                return Some(m.clone());
            }
        }
    }

    // On Windows, the primary display is the one anchored at physical (0, 0)
    if let Some(prim) = monitors.iter().find(|m| m.position().x == 0 && m.position().y == 0) {
        return Some(prim.clone());
    }

    if let Ok(Some(prim)) = window.primary_monitor() {
        return Some(prim);
    }

    monitors.into_iter().next()
}

pub fn get_monitor_options(window: &WebviewWindow) -> Vec<MonitorOption> {
    let monitors = window.available_monitors().unwrap_or_default();
    let primary = window.primary_monitor().ok().flatten();
    let primary_name = primary.as_ref().and_then(|m| m.name().map(|s| s.to_string()));

    let mut list = Vec::new();

    let prim_w = primary.as_ref().map(|m| m.size().width).unwrap_or(1920);
    let prim_h = primary.as_ref().map(|m| m.size().height).unwrap_or(1080);
    let prim_scale = primary.as_ref().map(|m| m.scale_factor()).unwrap_or(1.0);

    list.push(MonitorOption {
        id: "primary".to_string(),
        label: "Primary Display (Default / Auto-Follow)".to_string(),
        is_primary: true,
        width: prim_w,
        height: prim_h,
        scale_factor: prim_scale,
    });

    for (i, m) in monitors.into_iter().enumerate() {
        let raw_name = m
            .name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Display {}", i + 1));
        let is_prim = primary_name.as_deref() == Some(&raw_name);
        let size = m.size();
        let scale = m.scale_factor();
        let logical_w = (size.width as f64 / scale).round() as u32;
        let logical_h = (size.height as f64 / scale).round() as u32;

        let label = format!(
            "Display {}: {} ({}x{} @ {}%)",
            i + 1,
            if is_prim { "Main / Built-in" } else { "External" },
            logical_w,
            logical_h,
            (scale * 100.0).round() as u32
        );

        list.push(MonitorOption {
            id: raw_name,
            label,
            is_primary: is_prim,
            width: size.width,
            height: size.height,
            scale_factor: scale,
        });
    }

    list
}

pub fn get_responsive_dimensions(
    window: &WebviewWindow,
    target_monitor: Option<&str>,
) -> NotchDimensions {
    let monitor = find_target_monitor(window, target_monitor);

    let mon_width = if let Some(mon) = monitor {
        mon.size().width as f64 / mon.scale_factor()
    } else {
        1920.0
    };

    let collapsed_width = (mon_width * 0.125).clamp(220.0, 260.0);
    let collapsed_height = 36.0;
    let expanded_width = (mon_width * 0.24).clamp(400.0, 540.0);
    let expanded_height = 232.0;
    let lyrics_height = 300.0;

    NotchDimensions {
        collapsed_width,
        collapsed_height,
        expanded_width,
        expanded_height,
        lyrics_height,
    }
}

pub const NOTCH_CANVAS_WIDTH: f64 = 760.0;
pub const NOTCH_CANVAS_HEIGHT: f64 = 400.0;

pub fn setup_notch_window(window: &WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let hwnd_val = HWND(hwnd.0 as _);
            let ex_style = GetWindowLongPtrW(hwnd_val, GWL_EXSTYLE);
            let new_ex_style = ex_style | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
            SetWindowLongPtrW(hwnd_val, GWL_EXSTYLE, new_ex_style);

            let style = GetWindowLongPtrW(hwnd_val, GWL_STYLE);
            let new_style = (style & !(WS_THICKFRAME.0 as isize) & !(WS_CAPTION.0 as isize)) | (WS_POPUP.0 as isize);
            SetWindowLongPtrW(hwnd_val, GWL_STYLE, new_style);
        }
    }
    reposition_notch(window, NOTCH_CANVAS_WIDTH, NOTCH_CANVAS_HEIGHT, None);
}

pub fn reposition_notch(
    window: &WebviewWindow,
    width: f64,
    height: f64,
    target_monitor: Option<&str>,
) {
    let monitor = find_target_monitor(window, target_monitor);

    if let Some(mon) = monitor {
        let scale = mon.scale_factor();
        let mon_size = mon.size();
        let mon_pos = mon.position();

        if let Ok(hwnd) = window.hwnd() {
            unsafe {
                let _ = windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext(
                    windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
                );
                let hwnd_val = HWND(hwnd.0 as _);

                let phys_w = (width * scale).round() as i32;
                let phys_h = (height * scale).round() as i32;
                let phys_x = mon_pos.x + (mon_size.width as i32 - phys_w) / 2;
                let phys_y = mon_pos.y;

                let mut current_rect = RECT::default();
                let _ = GetWindowRect(hwnd_val, &mut current_rect);
                if current_rect.left == phys_x
                    && current_rect.top == phys_y
                    && (current_rect.right - current_rect.left) == phys_w
                    && (current_rect.bottom - current_rect.top) == phys_h
                {
                    return;
                }

                let _ = SetWindowPos(
                    hwnd_val,
                    Some(HWND_TOPMOST),
                    phys_x,
                    phys_y,
                    phys_w,
                    phys_h,
                    SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSENDCHANGING,
                );

                // When moving across monitors with different DPI, Windows fires WM_DPICHANGED
                // which causes Tao's wndproc to scale the window using its own suggested rect,
                // shifting it off-center. We re-verify the rect immediately; if altered,
                // re-apply the exact centered coordinates (now on the target monitor, so no
                // second WM_DPICHANGED is dispatched).
                let mut after_rect = RECT::default();
                let _ = GetWindowRect(hwnd_val, &mut after_rect);
                if after_rect.left != phys_x
                    || after_rect.top != phys_y
                    || (after_rect.right - after_rect.left) != phys_w
                    || (after_rect.bottom - after_rect.top) != phys_h
                {
                    let _ = SetWindowPos(
                        hwnd_val,
                        Some(HWND_TOPMOST),
                        phys_x,
                        phys_y,
                        phys_w,
                        phys_h,
                        SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSENDCHANGING,
                    );
                }
            }
        } else {
            let mon_width_logical = mon_size.width as f64 / scale;
            let mon_x_logical = mon_pos.x as f64 / scale;
            let mon_y_logical = mon_pos.y as f64 / scale;
            let center_x = mon_x_logical + (mon_width_logical - width) / 2.0;
            let top_y = mon_y_logical;
            let _ = window.set_size(LogicalSize::new(width, height));
            let _ = window.set_position(LogicalPosition::new(center_x, top_y));
        }
    }
}
