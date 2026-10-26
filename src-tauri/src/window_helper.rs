use serde::{Deserialize, Serialize};
use tauri::{LogicalPosition, LogicalSize, WebviewWindow};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_TOPMOST,
    SWP_NOACTIVATE, SWP_NOCOPYBITS, SWP_NOZORDER, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
};

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct NotchDimensions {
    pub collapsed_width: f64,
    pub collapsed_height: f64,
    pub expanded_width: f64,
    pub expanded_height: f64,
    pub lyrics_height: f64,
}

pub fn get_responsive_dimensions(window: &WebviewWindow) -> NotchDimensions {
    let monitor = match window.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => window.primary_monitor().ok().flatten(),
    };

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
    let dims = get_responsive_dimensions(window);
    reposition_notch(window, dims.collapsed_width, dims.collapsed_height);
}

pub fn reposition_notch(window: &WebviewWindow, width: f64, height: f64) {
    let monitor = match window.current_monitor() {
        Ok(Some(m)) => Some(m),
        _ => window.primary_monitor().ok().flatten(),
    };

    if let Some(mon) = monitor {
        let scale = mon.scale_factor();
        let mon_size = mon.size();
        let mon_pos = mon.position();

        let mon_width_logical = mon_size.width as f64 / scale;
        let mon_x_logical = mon_pos.x as f64 / scale;
        let mon_y_logical = mon_pos.y as f64 / scale;

        let center_x = mon_x_logical + (mon_width_logical - width) / 2.0;
        let top_y = mon_y_logical; // Flush at top of screen

        if let Ok(hwnd) = window.hwnd() {
            let phys_x = (center_x * scale).round() as i32;
            let phys_y = (top_y * scale).round() as i32;
            let phys_w = (width * scale).round() as i32;
            let phys_h = (height * scale).round() as i32;
            unsafe {
                let hwnd_val = HWND(hwnd.0 as _);
                let _ = SetWindowPos(
                    hwnd_val,
                    Some(HWND_TOPMOST),
                    phys_x,
                    phys_y,
                    phys_w,
                    phys_h,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                );
            }
        } else {
            let _ = window.set_size(LogicalSize::new(width, height));
            let _ = window.set_position(LogicalPosition::new(center_x, top_y));
        }
    }
}
