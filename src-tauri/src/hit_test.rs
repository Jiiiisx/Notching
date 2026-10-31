use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, WebviewWindow};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, GetCursorPos, GetWindowRect, MSG, MSLLHOOKSTRUCT,
    PostMessageW, SetWindowsHookExW, TranslateMessage, UnhookWindowsHookEx, WH_MOUSE_LL,
    WM_MOUSEHWHEEL, WM_MOUSEWHEEL,
};

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
    // scale factor (device px per CSS px), kept fresh by the poll thread so the
    // wheel hook can do the same inside-test without touching Tauri APIs.
    pub scale: Mutex<f64>,
}

impl Default for HitTestState {
    fn default() -> Self {
        Self {
            geometry: Mutex::new(PillGeometry::default()),
            is_ignoring_cursor: AtomicBool::new(true),
            scale: Mutex::new(1.0),
        }
    }
}

// HWND of the notch top-level window, refreshed by the poll thread (changes on
// monitor moves). The wheel hook uses it to redirect wheel events into the notch.
static NOTCH_HWND: AtomicUsize = AtomicUsize::new(0);

/// Same inside-test as the poll loop, callable from the wheel hook callback
/// (no Tauri calls, no R/W-Lock on the webview: just rect + geometry).
fn wheel_point_inside_notch(pt: (i32, i32), state: &HitTestState) -> bool {
    let hwnd_v = NOTCH_HWND.load(Ordering::Relaxed);
    if hwnd_v == 0 {
        return false;
    }
    let hwnd = HWND(hwnd_v as isize as *mut _);
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return false;
    }
    let (pill_w, pill_h, extra_bottom) = match state.geometry.lock() {
        Ok(g) => (g.width, g.height, g.extra_bottom),
        Err(_) => (210.0, 36.0, 0.0),
    };
    let scale = state.scale.lock().map(|s| *s).unwrap_or(1.0);
    let win_center_x = (rect.left + rect.right) / 2;
    let pill_w_phys = (pill_w * scale).round() as i32;
    let pill_h_phys = (pill_h * scale).round() as i32;
    let pill_left = win_center_x - (pill_w_phys / 2) - 6;
    let pill_right = win_center_x + (pill_w_phys / 2) + 6;
    let pill_top = rect.top;
    let pill_bottom = rect.top + pill_h_phys + 6 + (extra_bottom * scale) as i32;
    pt.0 >= pill_left && pt.0 <= pill_right && pt.1 >= pill_top && pt.1 <= pill_bottom
}

unsafe extern "system" fn wheel_hook_proc(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        // NOTE: callback-statics only; never call Tauri APIs from LL hooks.
        if code >= 0 {
            let msg = wparam.0 as u32;
            if msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL {
                let m = *(lparam.0 as *const MSLLHOOKSTRUCT);
                // Geometry state is created in setup() before the hook starts.
                if let Some(state) = WHEEL_STATE.get() {
                    let pt = (m.pt.x, m.pt.y);
                    if wheel_point_inside_notch(pt, state) {
                        let hwnd_v = NOTCH_HWND.load(Ordering::Relaxed);
                        if hwnd_v != 0 {
                            // Re-post the wheel straight into the notch webview:
                            // WM_MOUSEWHEEL wparam = MARKWPARAM(flags, delta),
                            // lparam = MAKELPARAM(x, y). Swallow the original so
                            // the window under the cursor (browser behind) never
                            // scrolls while the pointer is over the notch.
                            let delta = ((m.mouseData >> 16) & 0xFFFF) as isize;
                            let wp = WPARAM((delta << 16) as usize);
                            let lp = LPARAM(((pt.1 as isize) << 16) | (pt.0 as isize & 0xFFFF));
                            let hwnd = HWND(hwnd_v as isize as *mut _);
                            let _ = PostMessageW(Some(hwnd), msg, wp, lp);
                            return LRESULT(1);
                        }
                    }
                }
            }
        }
        CallNextHookEx(None, code, wparam, lparam)
    }
}

// Stored once at hook startup; OnceLock keeps the callback signature simple.
static WHEEL_STATE: std::sync::OnceLock<Arc<HitTestState>> = std::sync::OnceLock::new();

/// WH_MOUSE_LL hook: wheel events with the cursor inside the notch region are
/// redirected into the notch webview and swallowed. This is the OS-level
/// guarantee behind "scroll di notch tidak menggeser app di belakangnya".
pub fn start_wheel_redirect(_app: AppHandle, state: Arc<HitTestState>) {
    let _ = WHEEL_STATE.set(state);
    let _ = std::thread::Builder::new()
        .name("wheel-redirect-hook".into())
        .spawn(move || unsafe {
            let hook = match SetWindowsHookExW(
                WH_MOUSE_LL,
                Some(wheel_hook_proc),
                std::option::Option::None,
                0,
            ) {
                Ok(h) => h,
                Err(_) => return,
            };
            let mut msg = MSG::default();
            loop {
                let r = GetMessageW(&mut msg, None, 0, 0);
                if r.0 <= 0 {
                    break;
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            let _ = UnhookWindowsHookEx(hook);
        });
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
            if let Ok(mut s) = state.scale.lock() {
                *s = scale;
            }
            NOTCH_HWND.store(hwnd_val.0 as usize, Ordering::Relaxed);
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
