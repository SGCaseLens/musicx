use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricLine {
    pub start_ms: i64,
    pub end_ms: Option<i64>,
    pub text: String,
    pub secondary_text: Option<String>,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LyricsDocument {
    pub source_kind: String,
    pub provider: String,
    pub lang: Option<String>,
    pub raw_text: Option<String>,
    pub is_synced: bool,
    pub confidence: f32,
    pub source_duration_ms: Option<i64>,
    pub global_offset_ms: i64,
    pub lines: Vec<LyricLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub source_kind: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: i64,
    pub file_path: String,
    pub original_path: Option<String>,
    pub cover_art_path: Option<String>,
    pub language: Option<String>,
    pub youtube_video_id: Option<String>,
    pub youtube_url: Option<String>,
    pub lyrics: Option<LyricsDocument>,
    pub is_favorite: bool,
    pub play_count: i64,
    pub last_played_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub tracks: Vec<Track>,
    pub imported: usize,
    pub skipped: usize,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyStatus {
    pub yt_dlp_ready: bool,
    pub ffmpeg_ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    pub locale: String,
    pub app_data_dir: String,
    pub library_dir: String,
    pub dependency_status: DependencyStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackListPayload {
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTrackResult {
    pub deleted_track_id: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubeSearchResult {
    pub id: String,
    pub title: String,
    pub channel: String,
    pub duration_ms: Option<i64>,
    pub thumbnail_url: Option<String>,
    pub webpage_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadYoutubeRequest {
    pub video_id: Option<String>,
    pub url: Option<String>,
    pub title: Option<String>,
    pub preferred_language: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressEvent {
    pub task_id: String,
    pub video_id: Option<String>,
    pub stage: String,
    pub progress: f32,
    pub message: String,
    pub track: Option<Track>,
}
