use serde::{Deserialize, Serialize};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MediaTrackInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub is_playing: bool,
    pub has_media: bool,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub source_app: String,
}

pub fn get_current_media_track() -> Result<MediaTrackInfo, Box<dyn std::error::Error>> {
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.join()?;
    let session = match manager.GetCurrentSession() {
        Ok(s) => s,
        Err(_) => return Ok(MediaTrackInfo::default()),
    };

    let playback_info = session.GetPlaybackInfo()?;
    let is_playing = playback_info.PlaybackStatus()? == GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing;

    let media_properties = session.TryGetMediaPropertiesAsync()?.join()?;
    let title = media_properties.Title().unwrap_or_default().to_string();
    let artist = media_properties.Artist().unwrap_or_default().to_string();
    let album = media_properties.AlbumTitle().unwrap_or_default().to_string();

    let (position_sec, duration_sec) = if let Ok(tl) = session.GetTimelineProperties() {
        let base_pos = tl.Position().map(|p| p.Duration as f64 / 10_000_000.0).unwrap_or(0.0);
        let dur = tl.EndTime().map(|e| e.Duration as f64 / 10_000_000.0).unwrap_or(0.0);

        let pos = if is_playing {
            if let Ok(last_updated) = tl.LastUpdatedTime() {
                let now_unix = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default();
                let now_windows_100ns = (now_unix.as_secs() as i64 + 11_644_473_600) * 10_000_000
                    + (now_unix.subsec_nanos() as i64 / 100);
                let diff_100ns = now_windows_100ns - last_updated.UniversalTime;
                if diff_100ns > 0 && diff_100ns < 3600 * 10_000_000 {
                    let elapsed = diff_100ns as f64 / 10_000_000.0;
                    (base_pos + elapsed).min(dur)
                } else {
                    base_pos
                }
            } else {
                base_pos
            }
        } else {
            base_pos
        };

        (pos, dur)
    } else {
        (0.0, 0.0)
    };

    let title_lower = title.to_lowercase();
    let is_browser_error = title_lower.starts_with("hmmm") || title_lower.contains("can't reach this page") || title_lower.contains("refused to connect");
    let has_media = !title.is_empty() && !is_browser_error;

    let source_app = session.SourceAppUserModelId().unwrap_or_default().to_string();

    Ok(MediaTrackInfo {
        title,
        artist,
        album,
        is_playing,
        has_media,
        position_sec,
        duration_sec,
        source_app,
    })
}

pub fn media_play_pause() -> Result<(), Box<dyn std::error::Error>> {
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.join()?;
    if let Ok(session) = manager.GetCurrentSession() {
        let _ = session.TryTogglePlayPauseAsync()?.join()?;
    }
    Ok(())
}

pub fn media_next() -> Result<(), Box<dyn std::error::Error>> {
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.join()?;
    if let Ok(session) = manager.GetCurrentSession() {
        let _ = session.TrySkipNextAsync()?.join()?;
    }
    Ok(())
}

pub fn media_previous() -> Result<(), Box<dyn std::error::Error>> {
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.join()?;
    if let Ok(session) = manager.GetCurrentSession() {
        let _ = session.TrySkipPreviousAsync()?.join()?;
    }
    Ok(())
}
