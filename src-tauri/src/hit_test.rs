use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, WebviewWindow};
use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect};

#[derive(Debug, Clone)]
pub struct PillGeometry {
    pub is_expanded: bool,
    pub width: f64,
    pub height: f64,
    // tambahan tinggi interaksi di bawah pill (popup menu "..." mengoverflow panel)
    pub extra_bottom: f64,
}

impl Default for PillGeometry {
    fn default() -> Self {
        Self {
            is_expanded: false,
            width: 210.0,
            height: 36.0,
            extra_bottom: 0.0,
        }
    }
}

pub struct HitTestState {
    pub geometry: Mutex<PillGeometry>,
    pub is_ignoring_cursor: AtomicBool,
}

impl Default for HitTestState {
    fn default() -> Self {
        Self {
            geometry: Mutex::new(PillGeometry::default()),
            is_ignoring_cursor: AtomicBool::new(true),
        }
    }
}

pub fn start_cursor_hit_test(
    window: WebviewWindow,
    state: Arc<HitTestState>,
) {
    std::thread::spawn(move || {
        // Initially set click-through since notch starts collapsed
        let _ = window.set_ignore_cursor_events(true);
        state.is_ignoring_cursor.store(true, Ordering::Relaxed);

        let mut last_ignoring = true;
        let mut was_dragging_over_pill = false;

        loop {
            std::thread::sleep(Duration::from_millis(16)); // ~60 Hz

            let (pill_w, pill_h, extra_bottom) = {
                if let Ok(lock) = state.geometry.lock() {
                    (lock.width, lock.height, lock.extra_bottom)
                } else {
                    (210.0, 36.0, 0.0)
                }
            };

            // NOTE: the interactive region is always the pill/panel rect, expanded or not. Making the
            // whole window interactive while expanded turned its transparent area into an invisible
            // click-blocking layer over whatever sits behind (e.g. the settings window).

            let Ok(hwnd) = window.hwnd() else { continue };
            let hwnd_val = HWND(hwnd.0 as _);

            let mut rect = RECT::default();
            if unsafe { GetWindowRect(hwnd_val, &mut rect) }.is_err() {
                continue;
            }

            let mut pt = POINT::default();
            if unsafe { GetCursorPos(&mut pt) }.is_err() {
                continue;
            }

            let scale = window.scale_factor().unwrap_or(1.0);
            let win_center_x = (rect.left + rect.right) / 2;
            let pill_w_phys = (pill_w * scale).round() as i32;
            let pill_h_phys = (pill_h * scale).round() as i32;

            // 6px comfort margin around the pill so hover feels instantaneous
            let pill_left = win_center_x - (pill_w_phys / 2) - 6;
            let pill_right = win_center_x + (pill_w_phys / 2) + 6;
            let pill_top = rect.top;
            let pill_bottom = rect.top + pill_h_phys + 6 + (extra_bottom * scale) as i32;

            let inside_pill = pt.x >= pill_left
                && pt.x <= pill_right
                && pt.y >= pill_top
                && pt.y <= pill_bottom;

            if inside_pill {
                let lbutton_down = unsafe {
                    (GetAsyncKeyState(VK_LBUTTON.0 as i32) as u16 & 0x8000) != 0
                };
                if lbutton_down && !was_dragging_over_pill {
                    was_dragging_over_pill = true;
                    let _ = window.emit("notch-drag-hover-pill", true);
                } else if !lbutton_down {
                    was_dragging_over_pill = false;
                }
            } else {
                was_dragging_over_pill = false;
            }

            if inside_pill && last_ignoring {
                let _ = window.set_ignore_cursor_events(false);
                last_ignoring = false;
                state.is_ignoring_cursor.store(false, Ordering::Relaxed);
            } else if !inside_pill && !last_ignoring {
                let _ = window.set_ignore_cursor_events(true);
                last_ignoring = true;
                state.is_ignoring_cursor.store(true, Ordering::Relaxed);
            }
        }
    });
}
