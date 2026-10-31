//! Global low-level keyboard hook that intercepts hardware volume keys
//! (VK_VOLUME_UP / VK_VOLUME_DOWN / VK_VOLUME_MUTE) so Windows' built-in
//! Volume OSD flyout never appears — the notch slider is the only UI shown.
//!
//! The hook callback only suppresses the key and posts a thread message
//! (it must never block). A dedicated pump thread receives those messages
//! and notifies the frontend via the `volume-key` event; the frontend then
//! applies the step through the existing `set_master_volume` command,
//! which keeps audio state, notch HUD and Settings in one place.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use windows::Win32::Foundation::{HINSTANCE, HMODULE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::{
    GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW,
    PostThreadMessageW, RegisterClassW, SetWindowsHookExW, TranslateMessage,
    UnhookWindowsHookEx, CS_HREDRAW, CS_VREDRAW, HMENU, HWND_MESSAGE, KBDLLHOOKSTRUCT, MSG,
    WNDCLASSW, WINDOW_EX_STYLE, WINDOW_STYLE, WH_KEYBOARD_LL, WM_KEYDOWN, WS_OVERLAPPEDWINDOW,
};
use windows::core::{w, PCWSTR};

pub const VK_VOLUME_MUTE: u32 = 0xAD;
pub const VK_VOLUME_DOWN: u32 = 0xAE;
pub const VK_VOLUME_UP: u32 = 0xAF;

const WM_APP_VOL_UP: u32 = 0xB401;
const WM_APP_VOL_DOWN: u32 = 0xB402;
const WM_APP_VOL_MUTE: u32 = 0xB403;

static HOOK_PUMP_TID: AtomicU32 = AtomicU32::new(0);
static HOOK_ACTIVE: AtomicBool = AtomicBool::new(false);

unsafe extern "system" fn low_level_keyboard_proc(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT { unsafe {
    if code >= 0 && wparam.0 as u32 == WM_KEYDOWN {
        let kb = *(lparam.0 as *const KBDLLHOOKSTRUCT);
        let (msg, tid) = match kb.vkCode {
            VK_VOLUME_UP => (WM_APP_VOL_UP, HOOK_PUMP_TID.load(Ordering::Acquire)),
            VK_VOLUME_DOWN => (WM_APP_VOL_DOWN, HOOK_PUMP_TID.load(Ordering::Acquire)),
            VK_VOLUME_MUTE => (WM_APP_VOL_MUTE, HOOK_PUMP_TID.load(Ordering::Acquire)),
            // Bukan tombol volume: teruskan apa adanya ke Windows (larang menelan!)
            _ => return CallNextHookEx(None, code, wparam, lparam),
        };
        if tid != 0 {
            PostThreadMessageW(tid, msg, WPARAM(0), LPARAM(0));
        }
        return LRESULT(1); // swallow HANYA tombol volume: OSD Windows tidak muncul
    }
    CallNextHookEx(None, code, wparam, lparam)
}}

unsafe extern "system" fn msg_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT { unsafe {
    DefWindowProcW(hwnd, msg, wparam, lparam)
}}

/// Spawns a dedicated thread that installs the WH_KEYBOARD_LL hook and pumps
/// messages. Emits `volume-key` ("up" | "down" | "mute") for the frontend.
pub fn start_hook(app_handle: tauri::AppHandle) {
    use tauri::Emitter;
    std::thread::Builder::new()
        .name("volume-key-hook".into())
        .spawn(move || unsafe {
            let mut hmod = HMODULE::default();
            let _ = GetModuleHandleExW(
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                PCWSTR::null(),
                &mut hmod,
            );
            // HMODULE and HINSTANCE share representation.
            let hinst = HINSTANCE(hmod.0);

            let class_name = w!("notch_vol_hook");
            let wc = WNDCLASSW {
                lpfnWndProc: Some(msg_wnd_proc),
                lpszClassName: class_name,
                style: CS_HREDRAW | CS_VREDRAW,
                ..Default::default()
            };
            let _ = RegisterClassW(&wc);
            // Message-only window: invisible, keeps the thread's message queue
            // addressable without any visible window.
            let _msg_wnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                PCWSTR::null(),
                WINDOW_STYLE(WS_OVERLAPPEDWINDOW.0),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                Some(HMENU::default()),
                Some(hinst),
                None,
            )
            .ok();

            let hook = match SetWindowsHookExW(
                WH_KEYBOARD_LL,
                Some(low_level_keyboard_proc),
                Some(hinst),
                0,
            ) {
                Ok(h) => h,
                Err(_) => return, // hook failed: fall back to native OS behavior
            };
            HOOK_PUMP_TID.store(GetCurrentThreadId(), Ordering::Release);
            HOOK_ACTIVE.store(true, Ordering::Release);

            let mut msg = MSG::default();
            loop {
                let r = GetMessageW(&mut msg, None, 0, 0);
                if r.0 <= 0 {
                    break;
                }
                match msg.message {
                    WM_APP_VOL_UP => {
                        let _ = app_handle.emit("volume-key", "up");
                    }
                    WM_APP_VOL_DOWN => {
                        let _ = app_handle.emit("volume-key", "down");
                    }
                    WM_APP_VOL_MUTE => {
                        let _ = app_handle.emit("volume-key", "mute");
                    }
                    _ => {}
                }
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }

            HOOK_ACTIVE.store(false, Ordering::Release);
            let _ = UnhookWindowsHookEx(hook);
        });
}

/// Whether the low-level hook is installed and intercepting volume keys.
#[allow(dead_code)]
pub fn is_hook_active() -> bool {
    HOOK_ACTIVE.load(Ordering::Acquire)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vk_codes_match_winuser() {
        assert_eq!(VK_VOLUME_UP, 0xAF);
        assert_eq!(VK_VOLUME_DOWN, 0xAE);
        assert_eq!(VK_VOLUME_MUTE, 0xAD);
    }
}
