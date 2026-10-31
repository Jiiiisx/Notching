mod audio_manager;
mod game_detector;
mod hit_test;
mod media;
mod memory_manager;
mod notification_listener;
mod queue_server;
mod system_monitor;
mod volume_keys;
mod window_helper;

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
fn get_notch_config(
    app: AppHandle,
    state: tauri::State<Arc<game_detector::GameDetectorState>>,
    target_monitor: Option<String>,
) -> window_helper::NotchDimensions {
    if let Some(target) = &target_monitor {
        if let Ok(mut lock) = state.configured_monitor.lock() {
            *lock = Some(target.clone());
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        window_helper::get_responsive_dimensions(&window, target_monitor.as_deref())
    } else {
        window_helper::NotchDimensions {
            collapsed_width: 210.0,
            collapsed_height: 36.0,
            expanded_width: 420.0,
            expanded_height: 232.0,
            lyrics_height: 300.0,
        }
    }
}

#[tauri::command]
fn set_notch_state(app: AppHandle, _expanded: bool, target_monitor: Option<String>) {
    if let Some(window) = app.get_webview_window("main") {
        window_helper::reposition_notch(
            &window,
            window_helper::NOTCH_CANVAS_WIDTH,
            window_helper::NOTCH_CANVAS_HEIGHT,
            target_monitor.as_deref(),
        );
    }
}

#[tauri::command]
fn set_notch_size(
    app: AppHandle,
    state: tauri::State<Arc<game_detector::GameDetectorState>>,
    _width: f64,
    _height: f64,
    target_monitor: Option<String>,
) {
    if let Some(target) = &target_monitor {
        if let Ok(mut lock) = state.configured_monitor.lock() {
            *lock = Some(target.clone());
        }
    }
    // Respect temporary game mode shift if active
    let effective_monitor = if let Ok(lock) = state.active_shifted_monitor.lock() {
        lock.clone().or(target_monitor)
    } else {
        target_monitor
    };

    if let Some(window) = app.get_webview_window("main") {
        window_helper::reposition_notch(
            &window,
            window_helper::NOTCH_CANVAS_WIDTH,
            window_helper::NOTCH_CANVAS_HEIGHT,
            effective_monitor.as_deref(),
        );
        let _ = app.emit("notch-monitor-repositioned", effective_monitor);
    }
}

fn agent_skills_dir() -> std::path::PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
        .join("Notch")
        .join("skills")
}

#[tauri::command]
fn agent_list_skills() -> Vec<String> {
    match std::fs::read_dir(agent_skills_dir()) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| {
                e.path()
                    .extension()
                    .is_some_and(|x| x == "md")
            })
            .filter_map(|e| {
                e.path()
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
            })
            .collect(),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
fn agent_read_skill(name: String) -> Result<String, String> {
    let dir = agent_skills_dir();
    // no traversal: nama tidak boleh keluar dari folder skills
    if name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.trim().is_empty()
    {
        return Err("Nama skill tidak valid".into());
    }
    let path = agent_read_skill_inner(dir.join(format!("{}.md", name)))?;
    Ok(path)
}

/// File memori agent: %LOCALAPPDATA%\Notch\agent-memory.md — fakta permanen
/// tentang user & laptop, diinjeksi ke system prompt tiap pesan.
fn agent_memory_path() -> Option<std::path::PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let dir = std::path::Path::new(&base).join("Notch");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("agent-memory.md"))
}

#[tauri::command]
fn agent_memory_read() -> Option<String> {
    agent_memory_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.chars().take(8_000).collect())
}

#[tauri::command]
fn agent_memory_append(line: String) -> Result<String, String> {
    // runtime guard: satu baris saja, buang newline internal.
        let line = line.replace(['\r', '\n'], "");
    if line.trim().is_empty() {
        return Err("Fakta kosong".into());
    }
    let path = agent_memory_path().ok_or("LOCALAPPDATA tidak ada")?;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())?;
    // ponytail: file dibatasi 32KB — kalau penuh, potong baris terlama.
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 32_768 {
            if let Ok(text) = std::fs::read_to_string(&path) {
                let keep = &text[text.len() / 2..];
                let _ = std::fs::write(&path, keep.rsplit_once('\n').map(|x| x.0).unwrap_or(keep));
            }
        }
    }
    Ok(format!("Tersimpan: {line}"))
}

/// Buka .lnk/app via `cmd /c start` (stdlib). tauri_plugin_opener(\Verb open_path)
/// ternyata gagal diam-diam untuk sebagian .lnk Start Menu (contoh nyata:
/// Spotify.lnk); `start` utilisasi ShellExecute sama seperti Explorer.
/// CREATE_NO_WINDOW supaya tidak ada kilatan jendela cmd.
fn open_shortcut(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", path])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Gagal launcher \"{path}\": {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("open_app hanya untuk Windows".into())
    }
}

/// Cari app terpasang berdasarkan nama lewat shortcut Start Menu & Desktop
/// (.lnk). Return daftar .lnk; kosong dianggap tidak ketemu.
fn find_app(name: &str) -> Result<Vec<String>, String> {
    let needle = name.to_lowercase();
    if needle.is_empty() {
        return Err("Nama app kosong".into());
    }
    let mut roots = vec![
        std::path::PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"),
    ];
    if let Ok(appdata) = std::env::var("APPDATA") {
        roots.push(std::path::PathBuf::from(&appdata).join("Microsoft\\Windows\\Start Menu\\Programs"));
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        roots.push(std::path::PathBuf::from(&profile).join("Desktop"));
    }
    roots.push(std::path::PathBuf::from("C:\\Users\\Public\\Desktop"));
    let mut hits: Vec<String> = Vec::new();
    let mut stack = Vec::new();
    for r in roots.iter() {
        if r.exists() {
            stack.push((r.clone(), 0u32));
        }
    }
    while let Some((d, depth)) = stack.pop() {
        if depth > 5 || hits.len() >= 20 {
            continue;
        }
        let Ok(read) = std::fs::read_dir(&d) else { continue };
        for entry in read.flatten() {
            let p = entry.path();
            let fname = p.file_name().unwrap_or_default().to_string_lossy().to_lowercase();
            if fname == "desktop.ini" || fname == "temp" {
                continue;
            }
            if fname.contains(&needle) && fname.ends_with(".lnk") {
                hits.push(p.to_string_lossy().into_owned());
            }
            if p.is_dir() && hits.len() < 20 {
                stack.push((p, depth + 1));
            }
        }
    }
    if hits.is_empty() {
        return Err(format!(
            "App \"{name}\" tidak ditemukan di Start Menu/Desktop laptop ini. Tanyakan ke user: mau dibuka lewat browser atau tidak. Jangan buka apa pun sebelum user menjawab."
        ));
    }
    Ok(hits)
}

fn agent_read_skill_inner(path: std::path::PathBuf) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Cari file/dfolder berdasarkan nama (case-insensitive substring) di folder
/// umum user, atau di `dir` kalau diberikan. Hard cap supaya tidak menggantung
/// selamanya di drive besar.
fn find_files(query: &str, dir: Option<&str>) -> Result<String, String> {
    use std::sync::atomic::{AtomicU32, Ordering};
    const MAX_SCAN: u32 = 30_000;
    const MAX_HITS: usize = 30;

    let mut roots: Vec<std::path::PathBuf> = match dir {
        Some(d) => vec![std::path::PathBuf::from(d)],
        None => {
            let home = std::env::var("USERPROFILE").map_err(|_| "USERPROFILE tidak ada")?;
            ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music"]
                .iter()
                .map(|d| std::path::PathBuf::from(&home).join(d))
                .chain(std::iter::once(std::path::PathBuf::from("D:\\")))
                .collect()
        }
    };
    roots.retain(|p| p.exists());
    // ponytail: skip hardcoded dir-name berat supaya walk cepat;
    // kalau user butuh cari di SteamLibrary/node_modules, lewat argumen `dir`.
    const SKIP: [&str; 6] = ["node_modules", ".git", "$RECYCLE.BIN", "System Volume Information", "steamapps", "AppData"];
    let scanned = AtomicU32::new(0);
    let mut hits: Vec<String> = Vec::new();
    let mut stack = roots;
    while let Some(d) = stack.pop() {
        if scanned.load(Ordering::Relaxed) >= MAX_SCAN || hits.len() >= MAX_HITS {
            break;
        }
        let Ok(read) = std::fs::read_dir(&d) else { continue };
        for entry in read.flatten() {
            if scanned.fetch_add(1, Ordering::Relaxed) >= MAX_SCAN {
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let p = entry.path();
            if name.to_lowercase().contains(query) {
                // Folder diberi trailing "\" supaya model tahu ini folder
                // (open_file path folder → File Explorer).
                let mut s = p.to_string_lossy().into_owned();
                if p.is_dir() {
                    s.push('\\');
                }
                hits.push(s);
                if hits.len() >= MAX_HITS {
                    break;
                }
            }
            if p.is_dir() && !SKIP.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                stack.push(p);
            }
        }
    }
    if hits.is_empty() {
        return Ok(format!("Tidak ada hasil untuk \"{query}\""));
    }
    let mut out = hits.join("\n");
    if hits.len() >= MAX_HITS || scanned.load(Ordering::Relaxed) >= MAX_SCAN {
        out.push_str("\n(berhenti lebih awal — percisikan query atau set arg `dir`)");
    }
    Ok(out)
}

#[cfg(test)]
mod find_tests {
    use super::find_files;
    #[test]
    fn finds_by_substring_case_insensitive() {
        let dir = std::env::temp_dir().join("notch_find_test");
        std::fs::create_dir_all(dir.join("nested")).unwrap();
        std::fs::write(dir.join("TesT_abc.txt"), "x").unwrap();
        std::fs::write(dir.join("nested").join("important-laporan.docx"), "x").unwrap();
        let out = find_files("test_abc", Some(dir.to_str().unwrap())).unwrap();
        assert!(out.contains("TesT_abc.txt"), "{out}");
        let out2 = find_files("laporan", Some(dir.to_str().unwrap())).unwrap();
        assert!(out2.contains("important-laporan.docx"), "{out2}");
        let none = find_files("tidakada", Some(dir.to_str().unwrap())).unwrap();
        assert!(none.contains("Tidak ada hasil"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[tauri::command]
fn agent_run_tool(
    app: AppHandle,
    name: String,
    args: serde_json::Value,
) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    match name.as_str() {
        "open_url" => {
            let url = args
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or("url wajib diisi")?;
            let url = if url.starts_with("http://") || url.starts_with("https://") {
                url.to_string()
            } else {
                format!("https://{}", url)
            };
            // spotify: URI langsung dari model: lewatkan tanpa diubah.
            if url.starts_with("spotify:") {
                app.opener()
                    .open_url(&url, None::<&str>)
                    .map_err(|e| e.to_string())?;
                return Ok(format!("Dibuka lewat aplikasi Spotify: {url}"));
            }
            // Spotify deep link: buka lewat aplikasi Spotify desktop, bukan
            // browser. open.spotify.com/<type>/<id> -> spotify:<type>:<id>.
            // ponytail: cek apakah protokol spotify: terpasang lewat try-open;
            // upgrade path: query registry HKEY_CLASSES_ROOT\spotify sekali.
            if url.starts_with("https://open.spotify.com/") {
                let segs: Vec<&str> = url
                    .trim_start_matches("https://open.spotify.com/")
                    .split(['/', '?', '#'])
                    .filter(|s| !s.is_empty())
                    .collect();
                let segs = if segs.first() == Some(&"intl") { segs[1..].to_vec() } else { segs };
                // /search/<judul...> -> spotify:search:<judul> di app desktop.
                let uri = if segs.first() == Some(&"search") {
                    let q = url
                        .trim_start_matches("https://open.spotify.com/search/")
                        .split(['/', '?', '#']).next().unwrap_or("");
                    Some(format!("spotify:search:{}", q.replace("%20", " ").replace('+', " ")))
                } else if segs.len() >= 2
                    && matches!(
                        segs[0],
                        "track" | "album" | "playlist" | "artist" | "episode" | "show"
                    ) {
                    Some(format!("spotify:{}:{}", segs[0], segs[1]))
                } else {
                    None
                };
                if let Some(uri) = uri {
                    if app.opener().open_url(&uri, None::<&str>).is_ok() {
                        return Ok(format!("Dibuka lewat aplikasi Spotify: {uri}"));
                    }
                }
            }
            app.opener()
                .open_url(&url, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(format!("Dibuka: {}", url))
        }
        "find_file" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .map(|s| s.to_lowercase())
                .ok_or("query wajib diisi")?;
            let dir = args.get("dir").and_then(|v| v.as_str()).map(String::from);
            find_files(&query, dir.as_deref())
        }
        "open_file" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("path wajib diisi")?;
            let p = std::path::Path::new(path)
                .canonicalize()
                .map_err(|_| format!("Path tidak ditemukan: {path}"))?;
            let p_str = p.to_string_lossy().replace(r"\\?\", "");
            if p.is_dir() {
                // Folder → File Explorer via `cmd /c start` (opener.open_path
                // ternyata sering diam-diam gagal, sama kasusnya dgn .lnk).
                open_shortcut(&p_str)?;
                return Ok(format!("Folder dibuka di File Explorer: {p_str}"));
            }
            if !p.is_file() {
                return Err(format!("Bukan file/folder: {path}"));
            }
            app.opener()
                .open_path(&p_str, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(format!("Dibuka: {}", p.display()))
        }
        "open_app" => {
            use tauri_plugin_opener::OpenerExt;
            let name = args
                .get("name")
                .and_then(|v| v.as_str())
                .ok_or("name wajib diisi")?;
            // Kalau user kasih path folder (ada di disk), buka di Explorer langsung.
            let as_dir = std::path::Path::new(name);
            if as_dir.is_dir() {
                let dir_str = as_dir
                    .to_string_lossy()
                    .replace(r"\\?\", "");
                open_shortcut(&dir_str)?;
                return Ok(format!("Folder dibuka di File Explorer: {dir_str}"));
            }
            let hits = find_app(name)?;
            if hits.len() > 1 {
                // Jangan buka apa pun: biar model tanya user (nama app
                // ambigu, mis. "Spotify" kena Spotify + Spotify Labs).
                return Ok(format!(
                    "Ada {} app bernama mirip \"{}\". JANGAN buka dulu. Jawab user dengan daftar pilihannya (nama app saja, satu per baris, tanpa path), lalu tunggu user memilih:\n{}",
                    hits.len(), name, hits.join("\n")
                ));
            }
            open_shortcut(&hits[0])?;
            Ok(format!("Dibuka app: {}", hits[0]))
        }
        "memory" => agent_memory_append(
            args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        ),
        "open_search" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or("query wajib diisi")?;
            let search_url = format!(
                "https://www.google.com/search?q={}",
                query.replace(' ', "+")
            );
            app.opener()
                .open_url(&search_url, None::<&str>)
                .map_err(|e| e.to_string())?;
            Ok(format!("Pencarian dibuka: {}", query))
        }
        "media_play_pause" => {
            media_toggle_play()?;
            Ok("OK".to_string())
        }
        "media_next" => {
            media_next_track()?;
            Ok("OK".to_string())
        }
        "media_prev" => {
            media_prev_track()?;
            Ok("OK".to_string())
        }
        "set_volume" => {
            let level = args
                .get("level")
                .and_then(|v| v.as_f64())
                .ok_or("level wajib diisi (0..1)")?;
            set_master_volume(app, level as f32)?;
            Ok("OK".to_string())
        }
        "get_media" => {
            let track = get_media_track().map_err(|e| e.to_string())?;
            Ok(format!(
                "judul={} artis={} memutar={}",
                track.title, track.artist, track.is_playing
            ))
        }
        _ => Err(format!("Tool {} tidak ada", name)),
    }
}

#[tauri::command]
fn update_notch_geometry(
    state: tauri::State<Arc<hit_test::HitTestState>>,
    game_state: tauri::State<Arc<game_detector::GameDetectorState>>,
    is_expanded: bool,
    width: Option<f64>,
    height: Option<f64>,
    natural_width: Option<f64>,
    extra_bottom: Option<f64>,
) {
    if let Ok(mut lock) = state.geometry.lock() {
        lock.is_expanded = is_expanded;
        if let Some(w) = width {
            lock.width = w;
        }
        if let Some(h) = height {
            lock.height = h;
        }
        if let Some(eb) = extra_bottom {
            lock.extra_bottom = eb.max(0.0);
        }
    }
    if let Some(nw) = natural_width {
        if nw >= 120.0 {
            game_state
                .notch_base_width
                .store(nw.round() as u32, Ordering::Relaxed);
        }
    }
}

#[tauri::command]
fn get_available_monitors(app: AppHandle) -> Vec<window_helper::MonitorOption> {
    if let Some(window) = app.get_webview_window("main") {
        window_helper::get_monitor_options(&window)
    } else {
        vec![]
    }
}

#[tauri::command]
fn get_media_track() -> Result<media::MediaTrackInfo, String> {
    media::get_current_media_track().map_err(|e| e.to_string())
}

#[tauri::command]
fn media_toggle_play() -> Result<(), String> {
    media::media_play_pause().map_err(|e| e.to_string())
}

#[tauri::command]
fn media_next_track() -> Result<(), String> {
    media::media_next().map_err(|e| e.to_string())
}

#[tauri::command]
fn media_prev_track() -> Result<(), String> {
    media::media_previous().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_audio_status() -> Result<audio_manager::AudioStatus, String> {
    audio_manager::get_audio_status().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_master_volume(app: AppHandle, level: f32) -> Result<(), String> {
    audio_manager::set_master_volume(level).map_err(|e| e.to_string())?;
    if let Ok(info) = audio_manager::get_quick_volume_info() {
        let _ = app.emit("audio_status_changed", &info);
    }
    Ok(())
}

#[tauri::command]
fn set_master_mute(app: AppHandle, mute: bool) -> Result<(), String> {
    audio_manager::set_master_mute(mute).map_err(|e| e.to_string())?;
    if let Ok(info) = audio_manager::get_quick_volume_info() {
        let _ = app.emit("audio_status_changed", &info);
    }
    Ok(())
}

#[tauri::command]
fn set_default_audio_device(
    app: AppHandle,
    device_id: String,
) -> Result<audio_manager::AudioStatus, String> {
    audio_manager::set_default_device(&device_id).map_err(|e| e.to_string())?;
    let status = audio_manager::get_audio_status().map_err(|e| e.to_string())?;
    if let Ok(info) = audio_manager::get_quick_volume_info() {
        let _ = app.emit("audio_status_changed", &info);
    }
    Ok(status)
}

#[tauri::command]
fn set_game_mode(state: tauri::State<Arc<game_detector::GameDetectorState>>, enabled: bool) {
    state.enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn set_smart_tab_avoidance(
    state: tauri::State<Arc<game_detector::GameDetectorState>>,
    enabled: bool,
) {
    state.smart_tab_enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        // Collapse the notch first: an expanded overlay sits always-on-top over the settings
        // window and swallows clicks in its transparent area.
        let _ = app.emit_to("main", "settings-opened", ());
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn drag_settings_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.start_dragging();
    }
}

#[tauri::command]
fn minimize_settings_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.minimize();
    }
}

#[tauri::command]
fn close_settings_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.hide();
    }
}

#[tauri::command]
fn open_system_path(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if path.starts_with("http://") || path.starts_with("https://") {
            Command::new("cmd")
                .args(["/c", "start", "", &path])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }

        let p = Path::new(&path);
        if p.is_dir() {
            Command::new("explorer")
                .arg(&path)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            Command::new("cmd")
                .args(["/c", "start", "", &path])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(())
    }
}

#[tauri::command]
fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Ok(())
    }
}

#[tauri::command]
fn get_system_quick_paths() -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        map.insert("Downloads".into(), format!("{}\\Downloads", home));
        map.insert("Documents".into(), format!("{}\\Documents", home));
        map.insert("Desktop".into(), format!("{}\\Desktop", home));
    }
    map
}

#[tauri::command]
fn get_system_stats(
    state: tauri::State<Arc<system_monitor::SystemMonitor>>,
) -> system_monitor::SystemStats {
    state.get_stats()
}

#[tauri::command]
fn trim_memory() {
    memory_manager::trim_memory();
}

#[tauri::command]
fn spotify_queue_action(action: String, uri: Option<String>) -> Result<(), String> {
    queue_server::enqueue_command(serde_json::json!({
        "action": action,
        "uri": uri
    }));
    Ok(())
}

#[tauri::command]
fn get_autostart_status() -> Result<bool, String> {
    let output = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "Notch"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(output.status.success())
}

#[tauri::command]
fn set_autostart_status(enable: bool) -> Result<bool, String> {
    if enable {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe_str = exe_path.to_string_lossy().to_string();
        let val = format!("\"{}\"", exe_str);
        let status = std::process::Command::new("reg")
            .args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "Notch",
                "/t",
                "REG_SZ",
                "/d",
                &val,
                "/f",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| e.to_string())?;
        Ok(status.success())
    } else {
        let _ = std::process::Command::new("reg")
            .args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "Notch",
                "/f",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
        Ok(false)
    }
}

#[cfg(target_os = "windows")]
fn start_global_hotkey(app: AppHandle) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetMessageW, MSG, WM_HOTKEY};

    std::thread::spawn(move || unsafe {
        // VK_N = 0x4E -> Ctrl+Alt+N toggles the Notch pill
        if RegisterHotKey(None, 1, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, 0x4E).is_err() {
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            if msg.message == WM_HOTKEY {
                let _ = app.emit("toggle-notch-shortcut", ());
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(dd) = event {
                match dd {
                    tauri::DragDropEvent::Enter { paths, position } => {
                        let _ = window.emit(
                            "notch-drag-enter",
                            serde_json::json!({
                                "paths": paths,
                                "x": position.x,
                                "y": position.y
                            }),
                        );
                    }
                    tauri::DragDropEvent::Over { position } => {
                        let _ = window.emit(
                            "notch-drag-over",
                            serde_json::json!({
                                "x": position.x,
                                "y": position.y
                            }),
                        );
                    }
                    tauri::DragDropEvent::Drop { paths, position } => {
                        let _ = window.emit(
                            "notch-drag-drop",
                            serde_json::json!({
                                "paths": paths,
                                "x": position.x,
                                "y": position.y
                            }),
                        );
                    }
                    tauri::DragDropEvent::Leave => {
                        let _ = window.emit("notch-drag-leave", ());
                    }
                    _ => {}
                }
            }
            if window.label() == "settings" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if window.label() == "main" {
                if let WindowEvent::ScaleFactorChanged { .. } = event {
                    let app_handle = window.app_handle().clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(30));
                        if let Some(main_win) = app_handle.get_webview_window("main") {
                            let effective_monitor = if let Some(state) =
                                app_handle.try_state::<Arc<game_detector::GameDetectorState>>()
                            {
                                if let Ok(lock) = state.active_shifted_monitor.lock() {
                                    lock.clone().or_else(|| {
                                        state.configured_monitor.lock().ok().and_then(|m| m.clone())
                                    })
                                } else {
                                    state.configured_monitor.lock().ok().and_then(|m| m.clone())
                                }
                            } else {
                                None
                            };

                            window_helper::reposition_notch(
                                &main_win,
                                window_helper::NOTCH_CANVAS_WIDTH,
                                window_helper::NOTCH_CANVAS_HEIGHT,
                                effective_monitor.as_deref(),
                            );
                        }
                    });
                }
            }
        })
        .setup(|app| {
            let hit_test_state = Arc::new(hit_test::HitTestState::default());
            app.manage(hit_test_state.clone());

            if let Some(window) = app.get_webview_window("main") {
                window_helper::setup_notch_window(&window);
                hit_test::start_cursor_hit_test(window.clone(), hit_test_state.clone());
                hit_test::start_wheel_redirect(app.handle().clone(), hit_test_state.clone());
            }

            let game_detector_state = Arc::new(game_detector::GameDetectorState::default());
            app.manage(game_detector_state.clone());
            game_detector::start_game_detector(app.handle().clone(), game_detector_state);

            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    if let Ok(info) = media::get_current_media_track() {
                        let _ = app_handle.emit("media-status", info);
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            });

            // Start Spicetify local queue server
            queue_server::start_queue_server(app.handle().clone());

            // Start system audio monitor (master volume & device changes)
            audio_manager::start_audio_monitor(app.handle().clone());

            // Global hook that swallows hardware volume keys (hides the native
            // Windows Volume OSD) and re-broadcasts them as `volume-key` events.
            volume_keys::start_hook(app.handle().clone());

            // Initialize system monitor
            let sys_monitor = system_monitor::SystemMonitor::new();
            app.manage(sys_monitor);

            // Start memory trimmer to actively reduce unused WebView2 RAM
            memory_manager::start_memory_trimmer();

            // Start zero-bloat Windows & Phone Link notification listener
            notification_listener::start_notification_listener(app.handle().clone());

            // Ctrl+Alt+N global shortcut to toggle the Notch
            #[cfg(target_os = "windows")]
            start_global_hotkey(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notch_config,
            agent_run_tool,
            agent_list_skills,
            agent_read_skill,
            agent_memory_read,
            agent_memory_append,
            set_notch_state,
            set_notch_size,
            update_notch_geometry,
            get_available_monitors,
            set_game_mode,
            set_smart_tab_avoidance,
            get_media_track,
            media_toggle_play,
            media_next_track,
            media_prev_track,
            open_settings,
            drag_settings_window,
            minimize_settings_window,
            close_settings_window,
            open_system_path,
            reveal_in_explorer,
            get_system_quick_paths,
            get_audio_status,
            set_master_volume,
            set_master_mute,
            set_default_audio_device,
            get_system_stats,
            get_autostart_status,
            set_autostart_status,
            trim_memory,
            spotify_queue_action,
            notification_listener::get_recent_notifications,
            notification_listener::dismiss_notification,
            notification_listener::clear_all_notifications,
            notification_listener::trigger_test_notification
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {

    #[test]
    fn inspect_monitors() {
        use windows::Win32::Graphics::Gdi::*;
        use windows::Win32::Foundation::*;
        use windows::core::BOOL;

        unsafe {
            #[link(name = "user32")]
            unsafe extern "system" {
                fn SetProcessDpiAwarenessContext(value: isize) -> BOOL;
            }
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
            let _ = SetProcessDpiAwarenessContext(-4);
            #[link(name = "Shcore")]
            unsafe extern "system" {
                fn GetDpiForMonitor(
                    hmonitor: HMONITOR,
                    dpi_type: i32,
                    dpi_x: *mut u32,
                    dpi_y: *mut u32,
                ) -> windows::core::HRESULT;
            }

            unsafe extern "system" fn monitor_enum(
                hmonitor: HMONITOR,
                _hdc: HDC,
                _rect: *mut RECT,
                _lparam: LPARAM,
            ) -> BOOL {
                let mut mi = MONITORINFOEXW {
                    monitorInfo: MONITORINFO {
                        cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
                        rcMonitor: RECT { left: 0, top: 0, right: 0, bottom: 0 },
                        rcWork: RECT { left: 0, top: 0, right: 0, bottom: 0 },
                        dwFlags: 0,
                    },
                    szDevice: [0u16; 32],
                };
                unsafe {
                    let _ = GetMonitorInfoW(hmonitor, &mut mi as *mut _ as *mut _);
                }
                let name = String::from_utf16_lossy(&mi.szDevice);
                let name = name.trim_matches('\0');
                let r = mi.monitorInfo.rcMonitor;
                let is_primary = (mi.monitorInfo.dwFlags & 1) != 0;
                let mut dx = 0u32;
                let mut dy = 0u32;
                unsafe {
                    let _ = GetDpiForMonitor(hmonitor, 0, &mut dx, &mut dy);
                }
                println!("MONITOR: hmon={:?} name='{}' primary={} rect=[{}, {} to {}, {}] w={} h={} dpi={}",
                    hmonitor, name, is_primary, r.left, r.top, r.right, r.bottom, r.right - r.left, r.bottom - r.top, dx);
                let width = 760.0;
                let height = 400.0;
                let scale = dx as f64 / 96.0;
                let mon_width_logical = (r.right - r.left) as f64 / scale;
                let mon_x_logical = r.left as f64 / scale;
                let mon_y_logical = r.top as f64 / scale;
                let center_x = mon_x_logical + (mon_width_logical - width) / 2.0;
                let top_y = mon_y_logical;
                let phys_x = (center_x * scale).round() as i32;
                let phys_y = (top_y * scale).round() as i32;
                let phys_w = (width * scale).round() as i32;
                let phys_h = (height * scale).round() as i32;
                println!("  -> REPO RESULT: phys_x={} phys_y={} phys_w={} phys_h={}", phys_x, phys_y, phys_w, phys_h);
                BOOL(1)
            }
            let _ = EnumDisplayMonitors(None, None, Some(monitor_enum), LPARAM(0));
        }
    }
}
