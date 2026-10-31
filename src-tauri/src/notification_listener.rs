use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

pub type Sqlite3 = c_void;
pub type Sqlite3Stmt = c_void;

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_OPEN_READONLY: c_int = 0x00000001;
const SQLITE_OPEN_NOMUTEX: c_int = 0x00008000;
const EPOCH_DIFF_100NS: i64 = 116_444_736_000_000_000;

#[link(name = "winsqlite3")]
unsafe extern "system" {
    fn sqlite3_open_v2(
        filename: *const c_char,
        pp_db: *mut *mut Sqlite3,
        flags: c_int,
        z_vfs: *const c_char,
    ) -> c_int;
    fn sqlite3_busy_timeout(db: *mut Sqlite3, ms: c_int) -> c_int;
    fn sqlite3_prepare_v2(
        db: *mut Sqlite3,
        z_sql: *const c_char,
        n_byte: c_int,
        pp_stmt: *mut *mut Sqlite3Stmt,
        pz_tail: *mut *const c_char,
    ) -> c_int;
    fn sqlite3_step(stmt: *mut Sqlite3Stmt) -> c_int;
    fn sqlite3_finalize(stmt: *mut Sqlite3Stmt) -> c_int;
    fn sqlite3_column_int64(stmt: *mut Sqlite3Stmt, i_col: c_int) -> i64;
    fn sqlite3_column_text(stmt: *mut Sqlite3Stmt, i_col: c_int) -> *const u8;
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct NotchNotification {
    pub id: i64,
    pub source: String, // "phone" | "laptop"
    pub app_name: String,
    pub title: String,
    pub body: String,
    pub timestamp_ms: u64,
}

struct NotificationStore {
    items: Vec<NotchNotification>,
    dismissed_ids: Vec<i64>,
    cleared_up_to_id: i64,
    synthetic_counter: i64,
}

static STORE: LazyLock<Mutex<NotificationStore>> = LazyLock::new(|| {
    Mutex::new(NotificationStore {
        items: Vec::with_capacity(32),
        dismissed_ids: Vec::with_capacity(64),
        cleared_up_to_id: 0,
        synthetic_counter: 9_000_000_000,
    })
});

fn get_wpn_db_path() -> Option<PathBuf> {
    let local_app_data = std::env::var("LOCALAPPDATA").ok()?;
    let path = PathBuf::from(local_app_data)
        .join("Microsoft")
        .join("Windows")
        .join("Notifications")
        .join("wpndatabase.db");
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn clean_bidi_and_trim(input: &str) -> String {
    input
        .replace(['\u{200e}', '\u{200f}', '\u{202a}', '\u{202c}'], "")
        .trim()
        .to_string()
}

fn unescape_xml(input: &str) -> String {
    clean_bidi_and_trim(
        &input
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&#39;", "'")
            .replace("&#10;", " ")
            .replace("&#xA;", " ")
            .replace("&#13;", ""),
    )
}

fn extract_toast_texts(xml: &str) -> Vec<String> {
    let visual_slice = if let Some(actions_idx) = xml.find("<actions") {
        &xml[..actions_idx]
    } else {
        xml
    };

    let mut texts = Vec::new();
    let mut rest = visual_slice;

    while let Some(start_tag) = rest.find("<text") {
        let after_start = &rest[start_tag + 5..];
        if let Some(gt_pos) = after_start.find('>') {
            // Check for self-closing <text ... />
            if gt_pos > 0 && after_start.as_bytes()[gt_pos - 1] == b'/' {
                rest = &after_start[gt_pos + 1..];
                continue;
            }
            let content_start = &after_start[gt_pos + 1..];
            if let Some(end_tag) = content_start.find("</text>") {
                let raw_text = &content_start[..end_tag];
                let cleaned = unescape_xml(raw_text);
                if !cleaned.is_empty() {
                    texts.push(cleaned);
                }
                rest = &content_start[end_tag + 7..];
            } else {
                break;
            }
        } else {
            break;
        }
    }

    texts
}

fn classify_source_and_app(primary_id: &str, display_name: &str) -> (String, String) {
    let pid_lower = primary_id.to_lowercase();
    let is_phone = pid_lower.contains("yourphone")
        || pid_lower.contains("phonelink")
        || pid_lower.contains("phoneexperiencehost")
        || pid_lower.contains("kdeconnect");

    let source = if is_phone {
        "phone".to_string()
    } else {
        "laptop".to_string()
    };

    let cleaned_display = clean_bidi_and_trim(display_name);
    if !cleaned_display.is_empty() {
        return (source, cleaned_display);
    }

    if is_phone {
        if let Some(idx) = primary_id.find("YourPhoneNotifications_") {
            let pkg = &primary_id[idx + "YourPhoneNotifications_".len()..];
            if let Some(last_seg) = pkg.split('.').next_back() {
                if !last_seg.is_empty() {
                    let mut chars = last_seg.chars();
                    if let Some(first) = chars.next() {
                        let cap = first.to_uppercase().collect::<String>() + chars.as_str();
                        return (source, cap);
                    }
                }
            }
        }
        return (source, "Phone Link".to_string());
    }

    // Format desktop PrimaryId nicely
    let without_bang = primary_id.split('!').next().unwrap_or(primary_id);
    let last_segment = without_bang
        .split(['.', '\\', '/'])
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("exe"))
        .next_back()
        .unwrap_or("Sistem Windows");

    let friendly = match last_segment.to_lowercase().as_str() {
        "msedge" => "Microsoft Edge".to_string(),
        "chrome" => "Google Chrome".to_string(),
        "firefox" => "Firefox".to_string(),
        "code" => "VS Code".to_string(),
        "explorer" => "File Explorer".to_string(),
        _ => {
            let mut c = last_segment.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => "Aplikasi Laptop".to_string(),
            }
        }
    };

    (source, friendly)
}

unsafe fn col_string(stmt: *mut Sqlite3Stmt, idx: c_int) -> String {
    let ptr = unsafe { sqlite3_column_text(stmt, idx) };
    if ptr.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(ptr as *const c_char) }
            .to_string_lossy()
            .into_owned()
    }
}

fn parse_notification_row(
    id: i64,
    primary_id: &str,
    display_name: &str,
    arrival_filetime: i64,
    payload_xml: &str,
) -> Option<NotchNotification> {
    let texts = extract_toast_texts(payload_xml);
    if texts.is_empty() {
        return None;
    }

    let (source, app_name) = classify_source_and_app(primary_id, display_name);

    // Phone Link often puts the app_name as texts[0] when there are 3 text lines
    let (title, body) = if texts.len() >= 2 && texts[0].eq_ignore_ascii_case(&app_name) {
        let t = texts[1].clone();
        let b = if texts.len() > 2 {
            texts[2..].join(" • ")
        } else {
            String::new()
        };
        (t, b)
    } else {
        let t = texts[0].clone();
        let b = if texts.len() > 1 {
            texts[1..].join(" • ")
        } else {
            String::new()
        };
        (t, b)
    };

    let timestamp_ms = if arrival_filetime > EPOCH_DIFF_100NS {
        ((arrival_filetime - EPOCH_DIFF_100NS) / 10_000) as u64
    } else {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    };

    Some(NotchNotification {
        id,
        source,
        app_name,
        title,
        body,
        timestamp_ms,
    })
}

unsafe fn query_notifications(db: *mut Sqlite3, min_id_exclusive: i64, limit: i32) -> Vec<NotchNotification> {
    let sql = format!(
        "SELECT \
            n.Id, \
            IFNULL(h.PrimaryId, ''), \
            IFNULL((SELECT a.AssetValue FROM HandlerAssets a WHERE a.HandlerId = h.RecordId AND a.AssetKey = 'DisplayName' LIMIT 1), ''), \
            n.ArrivalTime, \
            CAST(n.Payload AS TEXT) \
         FROM Notification n \
         LEFT JOIN NotificationHandler h ON n.HandlerId = h.RecordId \
         WHERE n.Type = 'toast' AND n.Id > {} \
         ORDER BY n.Id DESC \
         LIMIT {};",
        min_id_exclusive, limit
    );

    let Ok(c_sql) = CString::new(sql) else {
        return Vec::new();
    };

    let mut stmt: *mut Sqlite3Stmt = std::ptr::null_mut();
    let rc = unsafe {
        sqlite3_prepare_v2(
            db,
            c_sql.as_ptr(),
            -1,
            &mut stmt,
            std::ptr::null_mut(),
        )
    };

    if rc != SQLITE_OK || stmt.is_null() {
        return Vec::new();
    }

    let mut out = Vec::new();
    while unsafe { sqlite3_step(stmt) } == SQLITE_ROW {
        let id = unsafe { sqlite3_column_int64(stmt, 0) };
        let primary_id = unsafe { col_string(stmt, 1) };
        let display_name = unsafe { col_string(stmt, 2) };
        let arrival_time = unsafe { sqlite3_column_int64(stmt, 3) };
        let payload = unsafe { col_string(stmt, 4) };

        // Skip internal Notch notifications if any
        if primary_id.to_lowercase().contains("tauri-app") {
            continue;
        }

        if let Some(notif) =
            parse_notification_row(id, &primary_id, &display_name, arrival_time, &payload)
        {
            out.push(notif);
        }
    }

    unsafe {
        sqlite3_finalize(stmt);
    }

    out
}

unsafe fn query_max_toast_id(db: *mut Sqlite3) -> i64 {
    let Ok(c_sql) = CString::new("SELECT IFNULL(MAX(Id), 0) FROM Notification WHERE Type = 'toast';") else {
        return 0;
    };
    let mut stmt: *mut Sqlite3Stmt = std::ptr::null_mut();
    let rc = unsafe {
        sqlite3_prepare_v2(db, c_sql.as_ptr(), -1, &mut stmt, std::ptr::null_mut())
    };
    if rc != SQLITE_OK || stmt.is_null() {
        return 0;
    }
    let mut max_id = 0;
    if unsafe { sqlite3_step(stmt) } == SQLITE_ROW {
        max_id = unsafe { sqlite3_column_int64(stmt, 0) };
    }
    unsafe {
        sqlite3_finalize(stmt);
    }
    max_id
}

pub fn start_notification_listener(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(db_path) = get_wpn_db_path() else {
            return;
        };
        let Some(path_str) = db_path.to_str() else {
            return;
        };
        let Ok(c_path) = CString::new(path_str) else {
            return;
        };

        let mut db: *mut Sqlite3 = std::ptr::null_mut();
        let rc = unsafe {
            sqlite3_open_v2(
                c_path.as_ptr(),
                &mut db,
                SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX,
                std::ptr::null(),
            )
        };
        if rc != SQLITE_OK || db.is_null() {
            return;
        }

        unsafe {
            sqlite3_busy_timeout(db, 200);
        }

        // Initial load of recent notifications (do not fire live popup for historical items)
        let mut last_seen_id = unsafe { query_max_toast_id(db) };
        let initial_items = unsafe { query_notifications(db, 0, 25) };

        if let Ok(mut store) = STORE.lock() {
            store.items = initial_items;
        }

        loop {
            std::thread::sleep(Duration::from_millis(950));

            let current_max_id = unsafe { query_max_toast_id(db) };
            if current_max_id > last_seen_id {
                let new_items = unsafe { query_notifications(db, last_seen_id, 10) };
                last_seen_id = current_max_id;

                if !new_items.is_empty() {
                    let newest = new_items[0].clone();
                    let snapshot = if let Ok(mut store) = STORE.lock() {
                        // Insert in chronological order so newest ends up at index 0
                        for item in new_items.into_iter().rev() {
                            if !store.dismissed_ids.contains(&item.id)
                                && item.id > store.cleared_up_to_id
                                && !store.items.iter().any(|existing| existing.id == item.id)
                            {
                                store.items.insert(0, item);
                            }
                        }
                        if store.items.len() > 35 {
                            store.items.truncate(35);
                        }
                        store.items.clone()
                    } else {
                        Vec::new()
                    };

                    let _ = app.emit("notch-notification-received", &newest);
                    let _ = app.emit("notch-notifications-updated", &snapshot);
                }
            }
        }
    });
}

#[tauri::command]
pub fn get_recent_notifications() -> Vec<NotchNotification> {
    if let Ok(store) = STORE.lock() {
        store.items.clone()
    } else {
        Vec::new()
    }
}

#[tauri::command]
pub fn dismiss_notification(app: AppHandle, id: i64) {
    if let Ok(mut store) = STORE.lock() {
        store.items.retain(|n| n.id != id);
        if !store.dismissed_ids.contains(&id) {
            store.dismissed_ids.push(id);
            if store.dismissed_ids.len() > 100 {
                store.dismissed_ids.remove(0);
            }
        }
        let snapshot = store.items.clone();
        let _ = app.emit("notch-notifications-updated", &snapshot);
    }
}

#[tauri::command]
pub fn clear_all_notifications(app: AppHandle) {
    if let Ok(mut store) = STORE.lock() {
        if let Some(max_real_id) = store
            .items
            .iter()
            .filter(|n| n.id < 9_000_000_000)
            .map(|n| n.id)
            .max()
        {
            if max_real_id > store.cleared_up_to_id {
                store.cleared_up_to_id = max_real_id;
            }
        }
        store.items.clear();
        let _ = app.emit("notch-notifications-updated", &Vec::<NotchNotification>::new());
    }
}

#[tauri::command]
pub fn trigger_test_notification(app: AppHandle, source: String) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    if let Ok(mut store) = STORE.lock() {
        store.synthetic_counter += 1;
        let id = store.synthetic_counter;

        let notif = if source == "phone" {
            NotchNotification {
                id,
                source: "phone".to_string(),
                app_name: "WhatsApp".to_string(),
                title: "Phone Link • Bluetooth".to_string(),
                body: "Sinkronisasi notifikasi HP ke Dynamic Notch aktif dan berjalan lancar.".to_string(),
                timestamp_ms: now_ms,
            }
        } else {
            NotchNotification {
                id,
                source: "laptop".to_string(),
                app_name: "Discord".to_string(),
                title: "Veteran Tech — Backend".to_string(),
                body: "Notifikasi sistem laptop berhasil ditampilkan di Dynamic Notch.".to_string(),
                timestamp_ms: now_ms,
            }
        };

        store.items.insert(0, notif.clone());
        if store.items.len() > 35 {
            store.items.truncate(35);
        }
        let snapshot = store.items.clone();

        let _ = app.emit("notch-notification-received", &notif);
        let _ = app.emit("notch-notifications-updated", &snapshot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_phone_and_laptop_notifications() {
        let phone_xml = r#"<toast><visual><binding template="ToastGeneric"><text id="1">GoPay</text><text id="2">Pembayaran Berhasil</text><text id="3">Rp25.000 di Indomaret &amp; Partner</text></binding></visual><actions><action content="Buka"/></actions></toast>"#;
        let parsed_phone = parse_notification_row(
            101,
            "Microsoft.YourPhone_8wekyb3d8bbwe!YourPhoneNotifications_com.go-jek.gopay",
            "\u{200e}GoPay",
            134_000_000_000_000_000,
            phone_xml,
        )
        .expect("should parse phone notification");

        assert_eq!(parsed_phone.source, "phone");
        assert_eq!(parsed_phone.app_name, "GoPay");
        assert_eq!(parsed_phone.title, "Pembayaran Berhasil");
        assert_eq!(parsed_phone.body, "Rp25.000 di Indomaret & Partner");

        let laptop_xml = r#"<toast><visual><binding template="ToastGeneric"><text>Veteran Tech</text><text>Deployment selesai</text></binding></visual></toast>"#;
        let parsed_laptop = parse_notification_row(
            102,
            "com.squirrel.Discord.Discord",
            "Discord",
            134_000_000_000_000_000,
            laptop_xml,
        )
        .expect("should parse laptop notification");

        assert_eq!(parsed_laptop.source, "laptop");
        assert_eq!(parsed_laptop.app_name, "Discord");
        assert_eq!(parsed_laptop.title, "Veteran Tech");
        assert_eq!(parsed_laptop.body, "Deployment selesai");
    }
}

