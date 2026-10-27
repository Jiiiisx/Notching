use serde::{Deserialize, Serialize};
use tauri::{LogicalPosition, LogicalSize, WebviewWindow};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
    SWP_NOACTIVATE, SWP_NOSENDCHANGING, SWP_NOZORDER, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
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
            if let Some(m) = monitors.iter().find(|m| m.name().is_some_and(|n| n == tid)) {
                return Some(m.clone());
            }
        }
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

    let collapsed_width = (mon_width * 0.11).clamp(170.0, 240.0);
    let collapsed_height = 36.0;
    let expanded_width = (mon_width * 0.24).clamp(400.0, 540.0);
    let expanded_height = 205.0;
    let lyrics_height = 300.0;

    NotchDimensions {
        collapsed_width,
        collapsed_height,
        expanded_width,
        expanded_height,
        lyrics_height,
    }
}

pub fn setup_notch_window(window: &WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let hwnd_val = HWND(hwnd.0 as _);
            let ex_style = GetWindowLongPtrW(hwnd_val, GWL_EXSTYLE);
            let new_style = ex_style | (WS_EX_NOACTIVATE.0 as isize) | (WS_EX_TOOLWINDOW.0 as isize);
            SetWindowLongPtrW(hwnd_val, GWL_EXSTYLE, new_style);
        }
    }
    let dims = get_responsive_dimensions(window, None);
    reposition_notch(window, dims.collapsed_width, dims.collapsed_height, None);
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

        let mon_width_logical = mon_size.width as f64 / scale;
        let mon_x_logical = mon_pos.x as f64 / scale;
        let mon_y_logical = mon_pos.y as f64 / scale;

        let center_x = mon_x_logical + (mon_width_logical - width) / 2.0;
        let top_y = mon_y_logical;

        if let Ok(hwnd) = window.hwnd() {
            let phys_x = (center_x * scale).round() as i32;
            let phys_y = (top_y * scale).round() as i32;
            let phys_w = (width * scale).round() as i32;
            let phys_h = (height * scale).round() as i32;
            unsafe {
                let hwnd_val = HWND(hwnd.0 as _);
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
            }
        } else {
            let _ = window.set_size(LogicalSize::new(width, height));
            let _ = window.set_position(LogicalPosition::new(center_x, top_y));
        }
    }
}
