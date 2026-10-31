use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

static PENDING_COMMANDS: Mutex<Vec<serde_json::Value>> = Mutex::new(Vec::new());

pub fn enqueue_command(cmd: serde_json::Value) {
    if let Ok(mut lock) = PENDING_COMMANDS.lock() {
        lock.push(cmd);
    }
}

pub fn pop_all_commands() -> Vec<serde_json::Value> {
    if let Ok(mut lock) = PENDING_COMMANDS.lock() {
        std::mem::take(&mut *lock)
    } else {
        Vec::new()
    }
}

pub fn start_queue_server(app_handle: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind("127.0.0.1:4545") {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Failed to bind queue server on 127.0.0.1:4545: {}", e);
                return;
            }
        };

        for stream in listener.incoming() {
            if let Ok(mut stream) = stream {
                let app = app_handle.clone();
                std::thread::spawn(move || {
                    handle_client(&mut stream, app);
                });
            }
        }
    });
}

fn handle_client(stream: &mut TcpStream, app: AppHandle) {
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(1500)));
    let mut buffer = [0u8; 8192];
    let mut received = Vec::new();
    let mut content_length: usize = 0;

    loop {
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                received.extend_from_slice(&buffer[..n]);
                if let Some(header_end) = received.windows(4).position(|w| w == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&received[..header_end]);
                    if headers.starts_with("OPTIONS") {
                        break;
                    }
                    content_length = headers
                        .lines()
                        .find(|l| l.to_lowercase().starts_with("content-length:"))
                        .and_then(|l| l.split(':').nth(1))
                        .and_then(|s| s.trim().parse().ok())
                        .unwrap_or(0);

                    if received.len() >= header_end + 4 + content_length {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }

    let request_str = String::from_utf8_lossy(&received);

    // Handle CORS preflight
    if request_str.starts_with("OPTIONS") {
        let response = "HTTP/1.1 200 OK\r\n\
                        Access-Control-Allow-Origin: *\r\n\
                        Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
                        Access-Control-Allow-Headers: Content-Type\r\n\
                        Access-Control-Allow-Private-Network: true\r\n\
                        Content-Length: 0\r\n\r\n";
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
        return;
    }

    // Handle GET /commands
    if request_str.starts_with("GET /commands") {
        let commands = pop_all_commands();
        let body = serde_json::json!({
            "status": "ok",
            "commands": commands
        }).to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Access-Control-Allow-Private-Network: true\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\r\n\
             {}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
        return;
    }

    // Handle POST /lyrics
    if request_str.starts_with("POST /lyrics") {
        if let Some(pos) = request_str.find("\r\n\r\n") {
            let start = pos + 4;
            let end = if content_length > 0 && start + content_length <= request_str.len() {
                start + content_length
            } else {
                request_str.len()
            };
            let body = &request_str[start..end];
            if let Ok(json_data) = serde_json::from_str::<serde_json::Value>(body) {
                let _ = app.emit("spotify-lyrics-update", json_data);
            }
        }
        let response = "HTTP/1.1 200 OK\r\n\
                        Access-Control-Allow-Origin: *\r\n\
                        Access-Control-Allow-Private-Network: true\r\n\
                        Content-Type: application/json\r\n\
                        Content-Length: 15\r\n\r\n\
                        {\"status\":\"ok\"}";
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
        return;
    }

    // Handle POST /queue
    if request_str.starts_with("POST") {
        if let Some(pos) = request_str.find("\r\n\r\n") {
            let start = pos + 4;
            let end = if content_length > 0 && start + content_length <= request_str.len() {
                start + content_length
            } else {
                request_str.len()
            };
            let body = &request_str[start..end];
            let _ = std::fs::write("C:/Users/HYPE AMD/AppData/Local/hermes/cache/scratch/notch_queue_raw.json", body);
            match serde_json::from_str::<serde_json::Value>(body) {
                Ok(json_data) => {
                    let track_count = json_data.get("tracks").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0);
                    println!("[queue_server] Received queue update with {} tracks", track_count);
                    let _ = std::fs::write(
                        "C:/Users/HYPE AMD/AppData/Local/hermes/cache/scratch/notch_queue_status.log",
                        format!("OK: {} tracks emitted\n", track_count)
                    );
                    let _ = app.emit("spotify-queue-update", json_data);
                }
                Err(err) => {
                    let msg = format!("ERR: Failed to parse JSON body: {} (body len: {})\n", err, body.len());
                    eprintln!("{}", msg);
                    let _ = std::fs::write("C:/Users/HYPE AMD/AppData/Local/hermes/cache/scratch/notch_queue_status.log", msg);
                }
            }
        }

        let commands = pop_all_commands();
        let body_resp = serde_json::json!({
            "status": "ok",
            "commands": commands
        }).to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\n\
             Access-Control-Allow-Origin: *\r\n\
             Access-Control-Allow-Private-Network: true\r\n\
             Content-Type: application/json\r\n\
             Content-Length: {}\r\n\r\n\
             {}",
            body_resp.len(),
            body_resp
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    }
}
