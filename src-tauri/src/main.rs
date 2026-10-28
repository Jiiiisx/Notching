// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Limit WebView2 Chromium RAM & disable redundant background services
    unsafe {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-features=TranslateUI,MediaSessionService,InterestFeedContentSuggestions,CalculateNativeWinOcclusion,IsolateOrigins,site-per-process --disable-background-networking --renderer-process-limit=1 --js-flags=--max-old-space-size=48",
        );
    }
    tauri_app_lib::run()
}
