// Prevents additional console window on Windows, DO NOT REMOVE!!
#![windows_subsystem = "windows"]

use windows::core::w;
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
use windows::Win32::System::Threading::CreateMutexW;

fn main() {
    unsafe {
        // Enforce strictly one running instance of Notch
        let _mutex = CreateMutexW(None, true, w!("Global\\Notch_Desktop_SingleInstance_Mutex"));
        if GetLastError() == ERROR_ALREADY_EXISTS {
            return;
        }

        // Limit WebView2 Chromium RAM & disable redundant background services
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=TranslateUI,MediaSessionService,InterestFeedContentSuggestions,CalculateNativeWinOcclusion,IsolateOrigins,site-per-process --disable-background-networking --renderer-process-limit=1 --js-flags=--max-old-space-size=48",
        );
    }
    tauri_app_lib::run()
}
