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
/// Cari file/folder → daftar (path, is_folder). Path folder diakhiri "\".
/// truncate=true kalau berhenti karena cap scan/hit.
fn find_hits(
    query: &str,
    dir: Option<&str>,
) -> Result<(Vec<(String, bool)>, bool), String> {
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
    let mut hits: Vec<(String, bool)> = Vec::new();
    let mut stack = roots;
    let mut truncated = false;
    while let Some(d) = stack.pop() {
        if scanned.load(Ordering::Relaxed) >= MAX_SCAN || hits.len() >= MAX_HITS {
            truncated = true;
            break;
        }
        let Ok(read) = std::fs::read_dir(&d) else { continue };
        for entry in read.flatten() {
            if scanned.fetch_add(1, Ordering::Relaxed) >= MAX_SCAN {
                truncated = true;
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let p = entry.path();
            if name.to_lowercase().contains(query) {
                // Folder diberi trailing "\" supaya model tahu ini folder
                // (open_file path folder → File Explorer).
                let mut s = p.to_string_lossy().into_owned();
                let is_dir = p.is_dir();
                if is_dir {
                    s.push('\\');
                }
                hits.push((s, is_dir));
                if hits.len() >= MAX_HITS {
                    truncated = true;
                    break;
                }
            }
            if p.is_dir() && !SKIP.iter().any(|s| name.eq_ignore_ascii_case(s)) {
                stack.push(p);
            }
        }
    }
    Ok((hits, truncated))
}

fn find_files(query: &str, dir: Option<&str>) -> Result<String, String> {
    let (hits, truncated) = find_hits(query, dir)?;
    if hits.is_empty() {
        return Ok(format!("Tidak ada hasil untuk \"{query}\""));
    }
    let mut out = hits.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>().join("\n");
    if truncated {
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

/// Daftar judul window yang user lihat sekarang (konteks layar agent).
#[cfg(target_os = "windows")]
fn visible_window_titles() -> Vec<String> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsIconic, IsWindowVisible,
    };
    unsafe extern "system" fn cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let titles = unsafe { &mut *(lparam.0 as *mut Vec<String>) };
        unsafe {
            if IsWindowVisible(hwnd).as_bool() && !IsIconic(hwnd).as_bool() {
                let len = GetWindowTextLengthW(hwnd);
                if len > 0 && len < 200 {
                    let mut buf = [0u16; 200];
                    GetWindowTextW(hwnd, &mut buf);
                    let t = String::from_utf16_lossy(&buf[..len as usize])
                        .trim()
                        .to_string();
                    // Window tema/overlay/noise berjudul generik — buang.
                    const SKIP: [&str; 5] = [
                        "Program Manager",
                        "Windows Input Experience",
                        "Microsoft Text Input Application",
                        "Settings",
                        "NVIDIA GeForce Overlay",
                    ];
                    if !t.is_empty() && !SKIP.iter().any(|s| t.eq_ignore_ascii_case(s)) {
                        titles.push(t);
                    }
                }
            }
        }
        BOOL(1)
    }
    let mut titles: Vec<String> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(cb),
            LPARAM(std::ptr::addr_of_mut!(titles) as isize),
        );
    }
    // Dedup jaga urutan (z-order ≈ paling depan duluan).
    let mut seen = std::collections::HashSet::new();
    titles
        .into_iter()
        .filter(|t| seen.insert(t.to_lowercase()))
        .take(12)
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn visible_window_titles() -> Vec<String> {
    Vec::new()
}

#[tauri::command]
fn list_windows() -> Vec<String> {
    visible_window_titles()
}

/// Query jadi URL-encoded (spasi = '+').
fn url_encode(q: &str) -> String {
    let mut out = String::new();
    for b in q.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Decode "%XX" + '+'→spasi (param uddg= link DuckDuckGo).
fn url_decode(s: &str) -> String {
    let b = s.replace('+', " ");
    let bytes = b.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &b[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Buang tag HTML: jadikan teks polos.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Parse HTML DuckDuckGo lite → (judul, url, snippet).
fn parse_ddg(html: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for chunk in html.split("class=\"result__a\"").skip(1) {
        let Some(hpos) = chunk.find("href=\"") else { continue };
        let after_h = &chunk[hpos + 6..];
        let Some(hend) = after_h.find('"') else { continue };
        let href = &after_h[..hend];
        let Some(cpos) = chunk.find("\">") else { continue };
        let after_t = &chunk[cpos + 2..];
        let Some(tend) = after_t.find("</a>") else { continue };
        let title = strip_tags(&after_t[..tend]);
        if title.is_empty() {
            continue;
        }
        // //duckduckgo.com/l/?uddg=<encoded>&rut=... → URL asli.
        let url = href
            .split("uddg=")
            .nth(1)
            .map(|u| {
                let raw = u.split('&').next().unwrap_or(u);
                url_decode(raw)
            })
            .unwrap_or_else(|| href.to_string());
        // Snippet: blok class="result__snippet" setelah judul.
        let snippet = after_t[tend..]
            .find("result__snippet")
            .and_then(|spos| {
                let rest = &after_t[tend + spos..];
                rest.find("\">").map(|s2| {
                    strip_tags(rest[s2 + 2..].split("</a>").next().unwrap_or("DEVNULL"))
                })
            })
            .unwrap_or_default();
        out.push((title, url, snippet));
        if out.len() >= 8 {
            break;
        }
    }
    out
}

/// Parse HTML hasil Brave Search (server-rendered) → (judul, url, snippet).
/// Anchor "data-type=\"web\"" tahan perubahan class svelte (hash berubah).
fn parse_brave(html: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for chunk in html.split("data-type=\"web\"").skip(1) {
        // Blok hasil berakhir sebelum section header berikutnya (diskusi/berita).
        let scope = &chunk[..chunk.find("<header").unwrap_or(chunk.len())];
        let Some(hpos) = scope.find("<a href=\"http") else { continue };
        let after_h = &scope[hpos + 9..];
        let Some(hend) = after_h.find('"') else { continue };
        let url = after_h[..hend].to_string();
        // Judul: <div class="title ..." title="...">...</div> — pakai atribut title= kalau ada.
        let mut title = String::new();
        if let Some(tpos) = scope.find("class=\"title ") {
            let rest = &scope[tpos..];
            if let Some(tend) = rest.find("</div>") {
                let seg = &rest[..tend];
                if let Some(q) = seg.find("title=\"") {
                    let v = &seg[q + 7..];
                    if let Some(e) = v.find('"') {
                        title = strip_tags(v[..e].trim());
                    }
                }
                if title.is_empty() {
                    // fallback: teks di dalam div
                    if let Some(g) = seg.find(">").map(|g| g + 1) {
                        title = strip_tags(&seg[g..]);
                    }
                }
            }
        }
        if title.is_empty() || url.starts_with("https://search.brave.com") {
            continue;
        }
        // Snippet: isi div class="content ..." di dalam generic-snippet.
        let snippet = scope
            .find("generic-snippet")
            .and_then(|gpos| {
                let rest = &scope[gpos..];
                rest.find("class=\"content ").and_then(|cpos| {
                    let c = &rest[cpos..];
                    c.find(">").map(|gt| {
                        strip_tags(
                            &c[gt + 1..]
                                .split("</div>")
                                .next()
                                .unwrap_or("DEVNULL")
                                .replace("&nbsp;", " "),
                        )
                    })
                })
            })
            .unwrap_or_default();
        let snippet = snippet.chars().take(300).collect::<String>();
        out.push((title, url, snippet));
        if out.len() >= 8 {
            break;
        }
    }
    out
}

/// Parse HTML hasil Bing → (judul, url, snippet).
fn parse_bing(html: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for chunk in html.split("class=\"b_algo\"").skip(1) {
        let Some(hpos) = chunk.find("href=\"") else { continue };
        let after_h = &chunk[hpos + 6..];
        let Some(hend) = after_h.find('"') else { continue };
        let url = &after_h[..hend];
        if !url.starts_with("http") {
            continue;
        }
        // Judul: teks antara akhir tag <a ...> dan </a> pertama.
        let Some(cpos) = after_h.find("\">") else { continue };
        let after_t = &after_h[cpos + 2..];
        let Some(tend) = after_t.find("</a>") else { continue };
        let title = strip_tags(&after_t[..tend]);
        if title.is_empty() {
            continue;
        }
        // Snippet: isi <p ...> pertama di blok hasil.
        let snippet = chunk
            .find("<p")
            .and_then(|ppos| {
                let rest = &chunk[ppos..];
                rest.find(">").map(|gt| {
                    strip_tags(rest[gt + 1..].split("</p>").next().unwrap_or("DEVNULL"))
                })
            })
            .unwrap_or_default();
        let snippet = snippet.chars().take(300).collect::<String>();
        out.push((title, url.to_string(), snippet));
        if out.len() >= 8 {
            break;
        }
    }
    out
}

/// Guard: agent tidak boleh menulis di area sistem Windows.
fn write_denied(path: &str) -> Option<String> {
    let lower = path.replace('/', r"\\").to_lowercase();
    const DENIED: [&str; 6] = [
        r"C:\\Windows",
        r"C:\\Program Files",
        r"C:\\Program Files (x86)",
        r"C:\\ProgramData",
        r"C:\\Users\\Public",
        r"C:\\Users\\Default",
    ];
    DENIED
        .iter()
        .find(|d| lower.starts_with(d.to_lowercase().as_str()))
        .map(|d| format!("Jangan tulis di area sistem ({d})"))
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
        "read_file" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("path wajib diisi (absolut)")?;
            let p = std::path::Path::new(path)
                .canonicalize()
                .map_err(|_| format!("Path tidak ditemukan: {path}"))?;
            if p.is_dir() {
                return Err("Folder, bukan file. Untuk isi folder pakai list_dir.".to_string());
            }
            let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
            if meta.len() > 2_000_000 {
                return Err(format!("File terlalu besar ({}, maks 2 MB teks)", meta.len()));
            }
            let data = std::fs::read(&p).map_err(|e| e.to_string())?;
            if data.contains(&0) {
                return Err("File biner (docx/xlsx/gambar?) tidak bisa dibaca sebagai teks.".to_string());
            }
            let text = String::from_utf8_lossy(&data);
            let chars: Vec<char> = text.chars().collect();
            if chars.len() > 6000 {
                Ok(format!(
                    "{}\n(terpotong, total {} karakter — pakai arg path ke bagian berikut kalau butuh)",
                    chars[..6000].iter().collect::<String>(),
                    chars.len()
                ))
            } else {
                Ok(text.into_owned())
            }
        }
        "write_file" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("path wajib diisi (absolut)")?;
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("content wajib diisi")?;
            let overwrite = args
                .get("overwrite")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let p = std::path::Path::new(path);
            if !p.is_absolute() {
                return Err("Path harus absolut (mis. D:\\Semester 1\\tugas.md).".to_string());
            }
            if let Some(msg) = write_denied(path) {
                return Err(msg);
            }
            if p.exists() && !overwrite {
                return Err(format!(
                    "File sudah ada: {}. Jangan timpa diam-diam. Baca dulu (read_file), lalu tanya user yakin mau ditimpa; kalau iya, panggil lagi dengan overwrite=true.",
                    p.display()
                ));
            }
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(p, content).map_err(|e| e.to_string())?;
            Ok(format!(
                "Tersimpan: {} ({} bytes)",
                p.display(),
                content.len()
            ))
        }
        "list_dir" => {
            let path = args
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or("path wajib diisi (absolut)")?;
            let p = std::path::Path::new(path)
                .canonicalize()
                .map_err(|_| format!("Folder tidak ditemukan: {path}"))?;
            if !p.is_dir() {
                return Err(format!("Bukan folder: {}", p.display()));
            }
            let mut dirs: Vec<String> = Vec::new();
            let mut files: Vec<(String, u64)> = Vec::new();
            let mut overflow = false;
            let mut count = 0usize;
            for entry in (std::fs::read_dir(&p).map_err(|e| e.to_string())?).flatten() {
                count += 1;
                if count > 150 {
                    overflow = true;
                    break;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.path().is_dir() {
                    dirs.push(format!("{name}\\"));
                } else {
                    files.push((name, entry.metadata().map(|m| m.len()).unwrap_or(0)));
                }
            }
            let mut lines = dirs;
            files.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
            for (name, len) in files {
                lines.push(format!("{name} ({len} b)"));
            }
            let mut out = lines.join("\n");
            if lines.is_empty() {
                out = "(folder kosong)".to_string();
            }
            if overflow {
                out.push_str("\n(dari 150 entri pertama — percisikan/ke folder yang lebih dalem)");
            }
            Ok(out)
        }
        "search_web" => {
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .ok_or("query wajib diisi")?;
            let q = url_encode(query);
            let fetch = |url: &str| -> Result<String, String> {
                let out = std::process::Command::new("curl.exe")
                    .args([
                        "-s",
                        "-m",
                        "15",
                        "-A",
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                        url,
                    ])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .map_err(|e| format!("Gagal menjalankan curl: {e}"))?;
                Ok(String::from_utf8_lossy(&out.stdout).into_owned())
            };
            // Mesin utama Brave (server-rendered; DDG/Bing sering diblok/rusak via curl).
            let mut results = parse_brave(
                &fetch(&format!("https://search.brave.com/search?q={q}")).unwrap_or_default(),
            );
            if results.is_empty() {
                // Fallback Bing html.
                if let Ok(h1) = fetch(&format!(
                    "https://www.bing.com/search?q={q}&count=10&mkt=id-ID"
                )) {
                    results = parse_bing(&h1);
                }
            }
            if results.is_empty() {
                // Fallback DDG lite (blok di banyak jaringan Indonesia).
                if let Ok(h2) = fetch(&format!("https://html.duckduckgo.com/html/?q={q}")) {
                    results = parse_ddg(&h2);
                }
            }
            if results.is_empty() {
                return Err("Pencarian web gagal (rate limit atau jaringan bermasalah). Tanyakan ke user mau dicoba lagi nanti.".to_string());
            }
            Ok(results
                .iter()
                .take(6)
                .enumerate()
                .map(|(i, (t, u, s))| {
                    if s.is_empty() {
                        format!("{}. {t}\n   {u}", i + 1)
                    } else {
                        format!("{}. {t}\n   {s}\n   {u}", i + 1)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n"))
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
            let hits = match find_app(name) {
                Ok(h) => h,
                Err(_) => {
                    // Bukan shortcut app: cari folder/file dengan nama itu
                    // di folder umum + D:\ (tanpa bergantung model memanggil
                    // find_file→open_file: model sering berhenti/berbohong).
                    let (hits, truncated) = find_hits(&name.to_lowercase(), None)?;
                    if hits.is_empty() {
                        return Err(format!(
                            "App/folder \"{name}\" tidak ditemukan di laptop ini. Tanyakan ke user: mau dibuka lewat browser atau tidak. Jangan buka apa pun sebelum user menjawab."
                        ));
                    }
                    if hits.len() > 1 || truncated {
                        return Ok(format!(
                            "Ada {} file/folder bernama mirip \"{}\". JANGAN buka dulu. Jawab user dengan daftar pilihannya (nama saja, satu per baris, tanpa path), lalu tunggu user memilih:\n{}",
                            hits.len(), name, hits.iter().map(|(p, _)| p.clone()).collect::<Vec<_>>().join("\n")
                        ));
                    }
                    let (path, is_dir) = &hits[0];
                    let clean = path.trim_end_matches('\\');
                    open_shortcut(clean)?;
                    return Ok(if *is_dir {
                        format!("Folder dibuka di File Explorer: {clean}")
                    } else {
                        format!("Dibuka file: {clean}")
                    });
                }
            };
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

#[cfg(test)]
#[rustfmt::skip]
mod agent_smart_tests {
    use super::{parse_brave, parse_bing, parse_ddg, url_decode, url_encode, write_denied};
    #[test]
    fn encodes_and_decodes_query() {
        assert_eq!(url_encode("membuat login PHP?"), "membuat+login+PHP%3F");
        assert_eq!(url_decode("membuat+login+PHP%3F"), "membuat login PHP?");
        assert_eq!(url_decode(&url_encode("a&b=c d/e")), "a&b=c d/e");
    }
    #[test]
    fn parses_ddg_results() {
        let html = r##"<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcontoh.dev%2Fcara-buat-login&rut=abc">Cara buat login PHP</a></div><a class="result__snippet" href="#">Snippet <b>teks</b> pertama</a>"##;
        let r = parse_ddg(html);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0, "Cara buat login PHP");
        assert_eq!(r[0].1, "https://contoh.dev/cara-buat-login");
        assert_eq!(r[0].2, "Snippet teks pertama");
    }
    #[test]
    fn parses_bing_results() {
        let html = r##"<li class="b_algo"><div><h2><a href="https://contoh.dev/bing">Judul Bing</a></h2><div class="b_caption"><p class="b_lineclamp">Snippet <b>Bing</b> pertama</p></div></div></li>"##;
        let r = parse_bing(html);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0, "Judul Bing");
        assert_eq!(r[0].1, "https://contoh.dev/bing");
        assert_eq!(r[0].2, "Snippet Bing pertama");
    }
    #[test]
    fn parses_brave_results() {
        let html = r##"<div class="snippet svelte-x" data-pos="1" data-type="web"><a href="https://contoh.dev/brave" class="svelte-14r20fy l1"><cite class="snippet-url">contoh.dev</cite><div class="title search-snippet-title svelte" title="Judul Brave">Judul Brave</div></a><div class="generic-snippet svelte"><div class="content svelte">Snip <b>brave</b> satu&nbsp;satu</div></div></div>"##;
        let r = parse_brave(html);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0, "Judul Brave");
        assert_eq!(r[0].1, "https://contoh.dev/brave");
        assert_eq!(r[0].2, "Snip brave satu satu");
    }
    #[test]
    fn blocks_system_write_paths() {
        assert!(write_denied(r"C:\\Windows\\System32\\x.txt").is_some());
        assert!(write_denied("C:/program files/app/config.ini").is_some());
        assert!(write_denied(r"D:\\Semester 1\\tugas.md").is_none());
        assert!(write_denied(r"C:\\Users\\HYPE AMD\\Documents\\notes.md").is_none());
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
            list_windows,
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
