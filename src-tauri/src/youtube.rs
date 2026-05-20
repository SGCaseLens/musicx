use crate::binaries::{ensure_ffmpeg, ensure_yt_dlp, refresh_yt_dlp, BinaryCommand};
use crate::lyrics::{
    build_lyrics_query, guess_language_from_lines, parse_lyrics_document, search_remote_lyrics,
};
use crate::paths::ensure_app_dirs;
use crate::types::{
    DownloadProgressEvent, DownloadYoutubeRequest, LyricsDocument, YoutubeSearchResult,
};
use anyhow::{Context, Result};
use regex::Regex;
use serde::Deserialize;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::time::{timeout, Duration};

const PROGRESS_PREFIX: &str = "[musicx-progress]";
const OUTPUT_PREFIX: &str = "[musicx-file]";

#[derive(Debug, Clone)]
pub struct DownloadedYoutubeAudio {
    pub file_path: PathBuf,
    pub cover_art_path: Option<String>,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: i64,
    pub youtube_video_id: Option<String>,
    pub youtube_url: Option<String>,
    pub lyrics: Option<LyricsDocument>,
}

#[derive(Debug, Deserialize)]
struct SearchEnvelope {
    entries: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeVideoItem {
    #[serde(rename = "_type")]
    item_type: Option<String>,
    ie_key: Option<String>,
    id: Option<String>,
    title: Option<String>,
    #[serde(alias = "webpage_url")]
    webpage_url: Option<String>,
    url: Option<String>,
    channel: Option<String>,
    uploader: Option<String>,
    duration: Option<f64>,
    thumbnail: Option<String>,
    thumbnails: Option<Vec<YoutubeThumbnail>>,
    artist: Option<String>,
    track: Option<String>,
    album: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct YoutubeThumbnail {
    url: Option<String>,
    width: Option<i64>,
    height: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LyricsIdentity {
    title: String,
    artist: String,
}

pub async fn search_youtube(
    app: &AppHandle,
    query: &str,
    limit: usize,
) -> Result<Vec<YoutubeSearchResult>> {
    let yt_dlp = ensure_yt_dlp(app)
        .await
        .context("failed to prepare yt-dlp for YouTube search")?;
    let mut errors = Vec::new();

    match search_youtube_with_command(&yt_dlp, query, limit).await {
        Ok(videos) => return Ok(videos),
        Err(error) => errors.push(error.to_string()),
    }

    match refresh_yt_dlp(app).await {
        Ok(refreshed) => match search_youtube_with_command(&refreshed, query, limit).await {
            Ok(videos) => return Ok(videos),
            Err(error) => errors.push(format!("after refreshing yt-dlp: {error}")),
        },
        Err(error) => errors.push(format!("failed to refresh yt-dlp: {error}")),
    }

    anyhow::bail!(
        "yt-dlp could not complete the YouTube search for \"{query}\". {}",
        errors.join(" | ")
    )
}

fn parse_search_entry(value: serde_json::Value) -> Option<YoutubeVideoItem> {
    if value.is_null() {
        return None;
    }

    serde_json::from_value(value).ok()
}

async fn search_youtube_with_command(
    command: &BinaryCommand,
    query: &str,
    limit: usize,
) -> Result<Vec<YoutubeSearchResult>> {
    let requested = search_request_limit(limit);
    let mut errors = Vec::new();

    match run_search_single_json(command, query, requested, limit).await {
        Ok(videos) if !videos.is_empty() => return Ok(videos),
        Ok(_) => return Ok(Vec::new()),
        Err(error) => errors.push(error.to_string()),
    }

    match run_search_json_lines(command, query, requested, limit).await {
        Ok(videos) if !videos.is_empty() => return Ok(videos),
        Ok(_) => return Ok(Vec::new()),
        Err(error) => errors.push(error.to_string()),
    }

    anyhow::bail!("{}", errors.join(" | "))
}

fn search_request_limit(limit: usize) -> usize {
    limit.saturating_mul(2).clamp(limit, 40)
}

fn common_search_args(query: &str, requested: usize) -> Vec<String> {
    vec![
        "--flat-playlist".to_string(),
        "--skip-download".to_string(),
        "--no-warnings".to_string(),
        "--ignore-errors".to_string(),
        "--extractor-retries".to_string(),
        "3".to_string(),
        "--socket-timeout".to_string(),
        "20".to_string(),
        format!("ytsearch{requested}:{query}"),
    ]
}

async fn run_search_single_json(
    command: &BinaryCommand,
    query: &str,
    requested: usize,
    limit: usize,
) -> Result<Vec<YoutubeSearchResult>> {
    let mut args = vec!["--dump-single-json".to_string()];
    args.extend(common_search_args(query, requested));
    let payload = run_json_command(command, &args).await?;
    search_results_from_payload(payload, limit)
}

async fn run_search_json_lines(
    command: &BinaryCommand,
    query: &str,
    requested: usize,
    limit: usize,
) -> Result<Vec<YoutubeSearchResult>> {
    let mut args = vec!["--dump-json".to_string()];
    args.extend(common_search_args(query, requested));
    let output = run_command_output(command, &args).await?;
    let videos = search_results_from_json_lines(&output.stdout, limit)?;

    if !output.status.success() && videos.is_empty() {
        let detail = extract_command_error_detail(&output.stderr, &output.stdout)
            .unwrap_or_else(|| format!("process exited with status {}", output.status));
        anyhow::bail!("{} exited with an error: {}", command.display_name, detail);
    }

    Ok(videos)
}

fn search_results_from_payload(
    payload: serde_json::Value,
    limit: usize,
) -> Result<Vec<YoutubeSearchResult>> {
    let envelope: SearchEnvelope =
        serde_json::from_value(payload).context("failed to parse yt-dlp search results")?;
    Ok(search_results_from_entries(
        envelope.entries.unwrap_or_default(),
        limit,
    ))
}

fn search_results_from_entries(
    entries: Vec<serde_json::Value>,
    limit: usize,
) -> Vec<YoutubeSearchResult> {
    entries
        .into_iter()
        .filter_map(parse_search_entry)
        .filter_map(convert_search_result)
        .take(limit)
        .collect::<Vec<_>>()
}

fn search_results_from_json_lines(bytes: &[u8], limit: usize) -> Result<Vec<YoutubeSearchResult>> {
    let text = String::from_utf8_lossy(bytes);
    let entries = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .collect::<Vec<_>>();

    Ok(search_results_from_entries(entries, limit))
}

pub async fn download_youtube_audio(
    app: &AppHandle,
    request: &DownloadYoutubeRequest,
    task_id: &str,
) -> Result<DownloadedYoutubeAudio> {
    let app_paths = ensure_app_dirs(app)?;
    let yt_dlp = ensure_yt_dlp(app).await?;
    let ffmpeg = ensure_ffmpeg(app).await?;
    let input_url = resolve_input_url(request)?;
    let info = fetch_video_info(&yt_dlp, &input_url).await?;

    let video_id = info
        .id
        .clone()
        .or_else(|| request.video_id.clone())
        .unwrap_or_else(|| "youtube".to_string());
    emit_progress(
        app,
        DownloadProgressEvent {
            task_id: task_id.to_string(),
            video_id: Some(video_id.clone()),
            stage: "prepare".to_string(),
            progress: 0.01,
            message: "Preparing YouTube download".to_string(),
            track: None,
        },
    );

    let job_dir = app_paths.temp.join(format!(
        "youtube-{}-{}",
        sanitize_segment(&video_id),
        sanitize_segment(task_id)
    ));
    tokio::fs::create_dir_all(&job_dir)
        .await
        .with_context(|| format!("failed to create {}", job_dir.display()))?;

    let ffmpeg_location = ffmpeg.program.to_string_lossy().to_string();
    let audio_args = build_audio_download_args(&ffmpeg_location, &job_dir, &input_url);
    let mut command = yt_dlp.command();
    command
        .args(&audio_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().context("failed to launch yt-dlp")?;
    let stdout = child
        .stdout
        .take()
        .context("failed to capture yt-dlp stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("failed to capture yt-dlp stderr")?;

    let progress_app = app.clone();
    let progress_video_id = video_id.clone();
    let progress_task_id = task_id.to_string();
    let stdout_task = tokio::spawn(async move {
        let mut final_path = None;
        let mut reader = BufReader::new(stdout).lines();

        while let Some(line) = reader
            .next_line()
            .await
            .context("failed to read yt-dlp stdout")?
        {
            if let Some(path) = line.strip_prefix(OUTPUT_PREFIX).map(str::trim) {
                if !path.is_empty() {
                    final_path = Some(PathBuf::from(path));
                }
                continue;
            }

            if let Some((progress, message)) = parse_progress_line(&line) {
                emit_progress(
                    &progress_app,
                    DownloadProgressEvent {
                        task_id: progress_task_id.clone(),
                        video_id: Some(progress_video_id.clone()),
                        stage: "download".to_string(),
                        progress,
                        message,
                        track: None,
                    },
                );
            }
        }

        Ok::<Option<PathBuf>, anyhow::Error>(final_path)
    });

    let stderr_task = tokio::spawn(async move {
        let mut lines = Vec::new();
        let mut reader = BufReader::new(stderr).lines();

        while let Some(line) = reader
            .next_line()
            .await
            .context("failed to read yt-dlp stderr")?
        {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            lines.push(trimmed.to_string());
            if lines.len() > 20 {
                lines.remove(0);
            }
        }

        Ok::<Vec<String>, anyhow::Error>(lines)
    });

    let status = match timeout(Duration::from_secs(20 * 60), child.wait()).await {
        Ok(result) => result.context("failed to wait for yt-dlp")?,
        Err(_) => {
            let _ = child.kill().await;
            cleanup_job_dir(&job_dir).await;
            anyhow::bail!("yt-dlp download timed out");
        }
    };
    let output_path = stdout_task.await.context("yt-dlp stdout task failed")??;
    let stderr_lines = stderr_task.await.context("yt-dlp stderr task failed")??;

    if !status.success() {
        let message = stderr_lines
            .last()
            .cloned()
            .unwrap_or_else(|| "yt-dlp failed to download the requested audio".to_string());
        emit_progress(
            app,
            DownloadProgressEvent {
                task_id: task_id.to_string(),
                video_id: Some(video_id.clone()),
                stage: "failed".to_string(),
                progress: 0.0,
                message: message.clone(),
                track: None,
            },
        );
        cleanup_job_dir(&job_dir).await;
        anyhow::bail!("{message}");
    }

    let downloaded_audio = output_path.unwrap_or_else(|| job_dir.join(format!("{video_id}.mp3")));
    if !downloaded_audio.exists() {
        cleanup_job_dir(&job_dir).await;
        anyhow::bail!(
            "yt-dlp reported success but the converted mp3 file was not found at {}",
            downloaded_audio.display()
        );
    }

    emit_progress(
        app,
        DownloadProgressEvent {
            task_id: task_id.to_string(),
            video_id: Some(video_id.clone()),
            stage: "postprocess".to_string(),
            progress: 0.9,
            message: "Validating converted MP3".to_string(),
            track: None,
        },
    );
    if let Err(error) = validate_downloaded_audio(&ffmpeg, &downloaded_audio).await {
        cleanup_job_dir(&job_dir).await;
        anyhow::bail!("{error}");
    }

    emit_progress(
        app,
        DownloadProgressEvent {
            task_id: task_id.to_string(),
            video_id: Some(video_id.clone()),
            stage: "postprocess".to_string(),
            progress: 0.92,
            message: "Finalizing audio and subtitles".to_string(),
            track: None,
        },
    );

    let title = request
        .title
        .clone()
        .or_else(|| info.track.clone())
        .or_else(|| info.title.clone())
        .unwrap_or_else(|| "YouTube Audio".to_string());
    let safe_title = sanitize_segment(&title);
    let final_audio_path = app_paths.library.join(format!(
        "{}-{}.mp3",
        if safe_title.is_empty() {
            "youtube-audio"
        } else {
            safe_title.as_str()
        },
        &video_id.chars().take(8).collect::<String>()
    ));
    replace_file(&downloaded_audio, &final_audio_path)?;

    let cover_art_path = if let Some(thumbnail) =
        find_generated_file(&job_dir, &video_id, &["jpg", "jpeg", "png", "webp"])
    {
        let extension = thumbnail
            .extension()
            .and_then(OsStr::to_str)
            .unwrap_or("jpg");
        let cover_path = app_paths.artwork.join(format!(
            "youtube-{}.{extension}",
            sanitize_segment(&video_id)
        ));
        replace_file(&thumbnail, &cover_path)?;
        Some(cover_path.to_string_lossy().to_string())
    } else {
        None
    };

    let duration_ms = info
        .duration
        .map(|value| (value * 1_000.0) as i64)
        .unwrap_or(0);
    let artist = info
        .artist
        .clone()
        .or_else(|| infer_artist_title_from_video_title(&title).map(|identity| identity.artist))
        .or_else(|| info.uploader.clone())
        .or_else(|| info.channel.clone())
        .unwrap_or_else(|| "YouTube".to_string());
    if let Some(warning) = download_subtitles_best_effort(
        app,
        &yt_dlp,
        &job_dir,
        &input_url,
        &video_id,
        task_id,
        request.preferred_language.as_deref(),
    )
    .await
    {
        emit_progress(
            app,
            DownloadProgressEvent {
                task_id: task_id.to_string(),
                video_id: Some(video_id.clone()),
                stage: "lyrics-warning".to_string(),
                progress: 0.94,
                message: warning,
                track: None,
            },
        );
    }
    let subtitle_lyrics = load_subtitle_lyrics(
        &job_dir,
        request.preferred_language.as_deref(),
        Some(duration_ms),
    )?;
    let lyrics = if should_search_remote_lyrics(subtitle_lyrics.as_ref()) {
        emit_progress(
            app,
            DownloadProgressEvent {
                task_id: task_id.to_string(),
                video_id: Some(video_id.clone()),
                stage: "postprocess".to_string(),
                progress: 0.96,
                message: "Searching lyrics because YouTube subtitles were missing or sparse"
                    .to_string(),
                track: None,
            },
        );
        search_remote_youtube_lyrics(&info, &title, &artist, duration_ms)
            .await
            .unwrap_or(None)
            .or(subtitle_lyrics)
    } else {
        subtitle_lyrics
    };
    cleanup_job_dir(&job_dir).await;

    Ok(DownloadedYoutubeAudio {
        file_path: final_audio_path,
        cover_art_path,
        title,
        artist,
        album: info.album.clone(),
        duration_ms,
        youtube_video_id: Some(video_id.clone()),
        youtube_url: info
            .webpage_url
            .clone()
            .or_else(|| Some(format!("https://www.youtube.com/watch?v={video_id}"))),
        lyrics,
    })
}

pub fn download_identity(request: &DownloadYoutubeRequest) -> Option<String> {
    request
        .video_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(extract_video_id)
        .or_else(|| {
            request
                .url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .filter(|value| is_supported_youtube_url(value))
                .and_then(extract_video_id)
        })
}

pub fn extract_video_id(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.len() == 11
        && trimmed
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Some(trimmed.to_string());
    }

    let pattern = Regex::new(r"(?:v=|/)([0-9A-Za-z_-]{11})(?:[?&#./]|$)").ok()?;
    pattern
        .captures(trimmed)
        .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
}

async fn cleanup_job_dir(path: &Path) {
    let _ = tokio::fs::remove_dir_all(path).await;
}

async fn run_json_command(command: &BinaryCommand, args: &[String]) -> Result<serde_json::Value> {
    let output = run_command_output(command, args).await?;

    if !output.status.success() {
        let detail = extract_command_error_detail(&output.stderr, &output.stdout)
            .unwrap_or_else(|| format!("process exited with status {}", output.status));
        anyhow::bail!("{} exited with an error: {}", command.display_name, detail);
    }

    serde_json::from_slice(&output.stdout).context("failed to parse yt-dlp JSON output")
}

async fn run_command_output(command: &BinaryCommand, args: &[String]) -> Result<Output> {
    let mut child = command.command();
    child.args(args);
    timeout(Duration::from_secs(75), child.output())
        .await
        .with_context(|| format!("{} timed out", command.display_name))?
        .with_context(|| format!("failed to run {}", command.display_name))
}

fn extract_command_error_detail(stderr: &[u8], stdout: &[u8]) -> Option<String> {
    summarize_output(stderr).or_else(|| summarize_output(stdout))
}

fn summarize_output(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| !line.eq_ignore_ascii_case("null"))
        .collect::<Vec<_>>();

    if lines.is_empty() {
        return None;
    }

    Some(
        lines
            .iter()
            .rev()
            .copied()
            .find(|line| {
                !line.starts_with("[debug]")
                    && !line.starts_with("[youtube]")
                    && !line.starts_with("[info]")
            })
            .unwrap_or(lines.last().copied().unwrap_or("command failed"))
            .to_string(),
    )
}

async fn fetch_video_info(command: &BinaryCommand, input_url: &str) -> Result<YoutubeVideoItem> {
    let payload = run_json_command(
        command,
        &[
            "--dump-single-json".to_string(),
            "--skip-download".to_string(),
            "--no-playlist".to_string(),
            "--no-warnings".to_string(),
            input_url.to_string(),
        ],
    )
    .await?;
    serde_json::from_value(payload).context("failed to parse yt-dlp metadata output")
}

fn convert_search_result(item: YoutubeVideoItem) -> Option<YoutubeSearchResult> {
    let thumbnail_url = best_thumbnail_url(&item);
    if !is_youtube_video_entry(&item) {
        return None;
    }
    let id = item.id?;
    if !is_youtube_video_id(&id) {
        return None;
    }
    let title = item.title?;
    let webpage_url = normalize_youtube_url(item.webpage_url.or(item.url), &id)
        .unwrap_or_else(|| youtube_watch_url(&id));
    Some(YoutubeSearchResult {
        id: id.clone(),
        title,
        channel: item
            .channel
            .or(item.uploader)
            .unwrap_or_else(|| "YouTube".to_string()),
        duration_ms: item.duration.map(|value| (value * 1_000.0) as i64),
        thumbnail_url: thumbnail_url
            .or_else(|| Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"))),
        webpage_url,
    })
}

fn best_thumbnail_url(item: &YoutubeVideoItem) -> Option<String> {
    item.thumbnail.clone().or_else(|| {
        item.thumbnails.as_ref().and_then(|thumbnails| {
            thumbnails
                .iter()
                .filter_map(|thumbnail| {
                    let area = thumbnail.width.unwrap_or(0) * thumbnail.height.unwrap_or(0);
                    thumbnail.url.as_ref().map(|url| (area, url.clone()))
                })
                .max_by_key(|(area, _)| *area)
                .map(|(_, url)| url)
        })
    })
}

fn resolve_input_url(request: &DownloadYoutubeRequest) -> Result<String> {
    if let Some(video_id) = request
        .video_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        let video_id = extract_video_id(video_id)
            .ok_or_else(|| anyhow::anyhow!("invalid YouTube video id"))?;
        return Ok(youtube_watch_url(&video_id));
    }

    if let Some(url) = request
        .url
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        if !is_supported_youtube_url(url) {
            anyhow::bail!("only YouTube video URLs are supported");
        }
        let video_id = extract_video_id(url)
            .ok_or_else(|| anyhow::anyhow!("only YouTube video URLs are supported"))?;
        return Ok(youtube_watch_url(&video_id));
    }

    anyhow::bail!("missing video id or url")
}

fn normalize_youtube_url(candidate: Option<String>, fallback_id: &str) -> Option<String> {
    let value = candidate?.trim().to_string();
    if value.is_empty() {
        return None;
    }

    if value.starts_with("http://") || value.starts_with("https://") {
        return Some(value);
    }

    if let Some(video_id) = extract_video_id(&value) {
        return Some(youtube_watch_url(&video_id));
    }

    if is_video_id_like(&value) {
        return Some(youtube_watch_url(&value));
    }

    Some(youtube_watch_url(fallback_id))
}

fn youtube_watch_url(video_id: &str) -> String {
    format!("https://www.youtube.com/watch?v={video_id}")
}

fn is_supported_youtube_url(value: &str) -> bool {
    let normalized = value.trim().to_ascii_lowercase();
    normalized.starts_with("https://www.youtube.com/")
        || normalized.starts_with("https://youtube.com/")
        || normalized.starts_with("https://m.youtube.com/")
        || normalized.starts_with("https://music.youtube.com/")
        || normalized.starts_with("https://youtu.be/")
}

fn is_video_id_like(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
}

fn is_youtube_video_id(value: &str) -> bool {
    value.len() == 11
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
}

fn is_youtube_video_entry(item: &YoutubeVideoItem) -> bool {
    if let Some(ie_key) = item.ie_key.as_deref() {
        if ie_key != "Youtube" {
            return false;
        }
    }

    if let Some(item_type) = item.item_type.as_deref() {
        if item_type != "url" && item_type != "video" {
            return false;
        }
    }

    true
}

fn build_subtitle_language_arg(preferred_language: Option<&str>) -> String {
    let mut values = Vec::new();
    let preferred = preferred_language
        .map(str::trim)
        .filter(|value| !value.is_empty());

    if let Some(language) = preferred {
        values.extend(expand_subtitle_language_preference(language));
    }

    for fallback in ["zh-Hans.*", "zh-Hant.*", "zh.*", "en.*", "ja.*", "ko.*"] {
        if !values.iter().any(|value| value == fallback) {
            values.push(fallback.to_string());
        }
    }

    values.join(",")
}

fn expand_subtitle_language_preference(language: &str) -> Vec<String> {
    let normalized = language.trim();
    let lower = normalized.to_ascii_lowercase();
    if lower == "zh" || lower.starts_with("zh-") {
        return [
            normalized.to_string(),
            format!("{normalized}.*"),
            "zh-Hans.*".to_string(),
            "zh-Hant.*".to_string(),
            "zh.*".to_string(),
        ]
        .into_iter()
        .collect();
    }

    [normalized.to_string(), format!("{normalized}.*")]
        .into_iter()
        .collect()
}

fn build_audio_download_args(
    ffmpeg_location: &str,
    job_dir: &Path,
    input_url: &str,
) -> Vec<String> {
    vec![
        "--no-playlist".to_string(),
        "--newline".to_string(),
        "--no-warnings".to_string(),
        "--ffmpeg-location".to_string(),
        ffmpeg_location.to_string(),
        "--format".to_string(),
        "bestaudio/best".to_string(),
        "--progress".to_string(),
        "--progress-template".to_string(),
        format!(
            "download:{PROGRESS_PREFIX}%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.eta)s|%(progress._speed_str)s"
        ),
        "--print".to_string(),
        format!("after_move:{OUTPUT_PREFIX}%(filepath)s"),
        "--paths".to_string(),
        job_dir.to_string_lossy().to_string(),
        "--output".to_string(),
        "%(id)s.%(ext)s".to_string(),
        "--output".to_string(),
        "thumbnail:%(id)s.%(ext)s".to_string(),
        "--write-thumbnail".to_string(),
        "--convert-thumbnails".to_string(),
        "jpg".to_string(),
        "-x".to_string(),
        "--audio-format".to_string(),
        "mp3".to_string(),
        "--audio-quality".to_string(),
        "320K".to_string(),
        input_url.to_string(),
    ]
}

async fn validate_downloaded_audio(command: &BinaryCommand, audio_path: &Path) -> Result<()> {
    let mut child = command.command();
    child
        .arg("-v")
        .arg("error")
        .arg("-i")
        .arg(audio_path)
        .arg("-f")
        .arg("null")
        .arg("-");

    let output = timeout(Duration::from_secs(75), child.output())
        .await
        .with_context(|| format!("audio validation timed out for {}", audio_path.display()))?
        .with_context(|| format!("failed to validate {}", audio_path.display()))?;
    let detail = extract_command_error_detail(&output.stderr, &output.stdout);

    if !output.status.success() {
        anyhow::bail!(
            "converted MP3 failed validation: {}",
            detail.unwrap_or_else(|| format!("ffmpeg exited with status {}", output.status))
        );
    }

    if let Some(detail) = detail {
        anyhow::bail!("converted MP3 failed validation: {detail}");
    }

    Ok(())
}

fn build_subtitle_download_args(
    job_dir: &Path,
    input_url: &str,
    preferred_language: Option<&str>,
) -> Vec<String> {
    vec![
        "--no-playlist".to_string(),
        "--skip-download".to_string(),
        "--no-warnings".to_string(),
        "--paths".to_string(),
        job_dir.to_string_lossy().to_string(),
        "--output".to_string(),
        "subtitle:%(id)s.%(ext)s".to_string(),
        "--write-subs".to_string(),
        "--write-auto-subs".to_string(),
        "--sub-langs".to_string(),
        build_subtitle_language_arg(preferred_language),
        "--sub-format".to_string(),
        "vtt/srt/best".to_string(),
        input_url.to_string(),
    ]
}

async fn download_subtitles_best_effort(
    app: &AppHandle,
    command: &BinaryCommand,
    job_dir: &Path,
    input_url: &str,
    video_id: &str,
    task_id: &str,
    preferred_language: Option<&str>,
) -> Option<String> {
    emit_progress(
        app,
        DownloadProgressEvent {
            task_id: task_id.to_string(),
            video_id: Some(video_id.to_string()),
            stage: "postprocess".to_string(),
            progress: 0.93,
            message: "Fetching available subtitles for synced lyrics".to_string(),
            track: None,
        },
    );

    let args = build_subtitle_download_args(job_dir, input_url, preferred_language);
    let mut child = command.command();
    child.args(&args);

    match timeout(Duration::from_secs(90), child.output()).await {
        Ok(Ok(output)) if output.status.success() => None,
        Ok(Ok(output)) => {
            subtitle_warning_from_output(&output.stderr, &output.stdout).or_else(|| {
                let detail = extract_command_error_detail(&output.stderr, &output.stdout)
                    .unwrap_or_else(|| "subtitle command exited without details".to_string());
                Some(format!(
                    "Audio downloaded, but subtitles could not be fetched: {detail}"
                ))
            })
        }
        Ok(Err(error)) => Some(format!(
            "Audio downloaded, but subtitles could not be fetched: {error}"
        )),
        Err(_) => Some(
            "Audio downloaded, but subtitle download timed out; continuing without lyrics"
                .to_string(),
        ),
    }
}

fn subtitle_warning_from_output(stderr: &[u8], stdout: &[u8]) -> Option<String> {
    let detail = extract_command_error_detail(stderr, stdout)?;
    classify_subtitle_warning(&detail)
}

fn classify_subtitle_warning(detail: &str) -> Option<String> {
    if !is_subtitle_related_error(detail) {
        return None;
    }

    Some(format!(
        "Audio downloaded, but subtitles were unavailable: {}",
        detail.trim()
    ))
}

fn is_subtitle_related_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("subtitle")
        || normalized.contains("subtitles")
        || normalized.contains(".vtt")
        || normalized.contains(".srt")
}

fn parse_progress_line(line: &str) -> Option<(f32, String)> {
    let payload = line.strip_prefix(PROGRESS_PREFIX)?;
    let mut parts = payload.split('|');
    let percent = parts
        .next()?
        .trim()
        .trim_end_matches('%')
        .trim()
        .parse::<f32>()
        .ok()
        .map(|value| (value / 100.0).clamp(0.0, 1.0))?;
    let downloaded = parts.next().unwrap_or("?");
    let total = parts.next().unwrap_or("?");
    let estimated = parts.next().unwrap_or("?");
    let eta = parts.next().unwrap_or("?");
    let speed = parts.next().unwrap_or("?");
    let total_display = if total.trim().is_empty() || total.trim() == "NA" {
        estimated
    } else {
        total
    };

    Some((
        percent,
        format!("Downloading audio ({downloaded} / {total_display}, ETA {eta}, speed {speed})"),
    ))
}

fn emit_progress(app: &AppHandle, event: DownloadProgressEvent) {
    let _ = app.emit("youtube-download-progress", event);
}

fn find_generated_file(dir: &Path, video_id: &str, extensions: &[&str]) -> Option<PathBuf> {
    let mut candidates = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_stem()
                .and_then(OsStr::to_str)
                .is_some_and(|stem| stem.starts_with(video_id))
                && path
                    .extension()
                    .and_then(OsStr::to_str)
                    .is_some_and(|extension| {
                        extensions
                            .iter()
                            .any(|candidate| extension.eq_ignore_ascii_case(candidate))
                    })
        })
        .collect::<Vec<_>>();

    candidates.sort();
    candidates.into_iter().next()
}

fn load_subtitle_lyrics(
    dir: &Path,
    preferred_language: Option<&str>,
    duration_ms: Option<i64>,
) -> Result<Option<LyricsDocument>> {
    let preferred_language = preferred_language
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_else(|| "en".to_string());

    let mut candidates = std::fs::read_dir(dir)?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .and_then(OsStr::to_str)
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("vtt") || extension.eq_ignore_ascii_case("srt")
                })
        })
        .collect::<Vec<_>>();

    candidates.sort_by_key(|path| subtitle_priority(path, &preferred_language));

    for path in candidates {
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read subtitle {}", path.display()))?;
        let language =
            extract_language_tag(path.file_name().and_then(OsStr::to_str).unwrap_or_default());
        if let Some(mut document) = parse_lyrics_document(
            "youtube_subtitle",
            "youtube",
            &raw,
            duration_ms,
            language,
            0.87,
        ) {
            document.lang = document
                .lang
                .or_else(|| guess_language_from_lines(&document.lines));
            return Ok(Some(document));
        }
    }

    Ok(None)
}

fn should_search_remote_lyrics(document: Option<&LyricsDocument>) -> bool {
    let Some(document) = document else {
        return true;
    };

    meaningful_lyric_line_count(&document.lines) < 4
}

fn meaningful_lyric_line_count(lines: &[crate::types::LyricLine]) -> usize {
    lines
        .iter()
        .filter(|line| {
            let text = clean_lyric_lookup_text(&line.text).to_ascii_lowercase();
            let normalized = text
                .trim_matches(|character: char| !character.is_alphanumeric())
                .to_string();
            if text.is_empty() {
                return false;
            }

            !matches!(
                normalized.as_str(),
                "music" | "applause" | "instrumental" | "intro" | "outro"
            ) && text
                .chars()
                .filter(|character| character.is_alphabetic())
                .count()
                >= 3
        })
        .count()
}

async fn search_remote_youtube_lyrics(
    info: &YoutubeVideoItem,
    display_title: &str,
    display_artist: &str,
    duration_ms: i64,
) -> Result<Option<LyricsDocument>> {
    let Some(identity) = infer_lyrics_identity(info, display_title, display_artist) else {
        return Ok(None);
    };

    let query = build_lyrics_query(
        &identity.title,
        &identity.artist,
        info.album.clone(),
        if duration_ms > 0 {
            Some(duration_ms)
        } else {
            None
        },
    )?;
    let mut lyrics = search_remote_lyrics(&query).await?;
    if let Some(ref mut document) = lyrics {
        document.lang = document
            .lang
            .clone()
            .or_else(|| guess_language_from_lines(&document.lines));
    }

    Ok(lyrics)
}

fn infer_lyrics_identity(
    info: &YoutubeVideoItem,
    display_title: &str,
    display_artist: &str,
) -> Option<LyricsIdentity> {
    if let (Some(track), Some(artist)) = (
        info.track.as_deref().and_then(clean_lyric_lookup_value),
        info.artist.as_deref().and_then(clean_lyric_lookup_value),
    ) {
        return Some(LyricsIdentity {
            title: track,
            artist,
        });
    }

    info.title
        .as_deref()
        .and_then(infer_artist_title_from_video_title)
        .or_else(|| infer_artist_title_from_video_title(display_title))
        .or_else(|| {
            let title = clean_lyric_lookup_value(display_title)?;
            let artist = clean_lyric_lookup_value(display_artist)?;
            if is_generic_youtube_artist(&artist) {
                return None;
            }

            Some(LyricsIdentity { title, artist })
        })
}

fn infer_artist_title_from_video_title(value: &str) -> Option<LyricsIdentity> {
    let cleaned = clean_video_title_for_lyrics(value);
    for separator in [" - ", " – ", " — ", " | ", " / "] {
        let Some((artist, title)) = cleaned.split_once(separator) else {
            continue;
        };
        let artist = clean_lyric_lookup_value(artist)?;
        let title = clean_lyric_lookup_value(title)?;
        if artist.len() < 2 || title.len() < 2 {
            continue;
        }

        return Some(LyricsIdentity { title, artist });
    }

    None
}

pub fn infer_lyrics_lookup_from_youtube_metadata(
    title: &str,
    artist: &str,
) -> Option<(String, String)> {
    infer_artist_title_from_video_title(title)
        .map(|identity| (identity.title, identity.artist))
        .or_else(|| {
            let title = clean_lyric_lookup_value(title)?;
            let artist = clean_lyric_lookup_value(artist)?;
            if is_generic_youtube_artist(&artist) {
                return None;
            }

            Some((title, artist))
        })
}

fn clean_video_title_for_lyrics(value: &str) -> String {
    let bracket_noise = Regex::new(
        r"(?i)\s*[\[(（【].*?\b(?:lyrics?|official|music\s*video|audio|mv|hd|4k|visualizer|live|版)\b.*?[\])）】]",
    )
    .ok();
    let trailing_noise = Regex::new(
        r"(?i)\s*[-–—|:]?\s*\b(?:official\s*)?(?:music\s*)?(?:video|audio|lyrics?|mv|visualizer|hd|4k)\b.*$",
    )
    .ok();
    let text = bracket_noise
        .as_ref()
        .map(|pattern| pattern.replace_all(value, " ").to_string())
        .unwrap_or_else(|| value.to_string());
    let text = trailing_noise
        .as_ref()
        .map(|pattern| pattern.replace_all(&text, " ").to_string())
        .unwrap_or(text);

    normalize_lookup_whitespace(&text)
}

fn clean_lyric_lookup_value(value: &str) -> Option<String> {
    let cleaned = clean_lyric_lookup_text(value);
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn clean_lyric_lookup_text(value: &str) -> String {
    let bracket_noise = Regex::new(
        r"(?i)\s*[\[(（【].*?\b(?:lyrics?|official|music\s*video|audio|mv|hd|4k|visualizer|live|版)\b.*?[\])）】]",
    )
    .ok();
    let noise_words =
        Regex::new(r"(?i)\b(?:official|lyrics?|music\s*video|audio|mv|hd|4k|visualizer)\b").ok();
    let text = bracket_noise
        .as_ref()
        .map(|pattern| pattern.replace_all(value, " ").to_string())
        .unwrap_or_else(|| value.to_string());
    let text = noise_words
        .as_ref()
        .map(|pattern| pattern.replace_all(&text, " ").to_string())
        .unwrap_or(text);

    normalize_lookup_whitespace(&text)
}

fn normalize_lookup_whitespace(value: &str) -> String {
    value
        .replace(['_', '\u{3000}'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches(|character: char| {
            matches!(
                character,
                '-' | '–' | '—' | '|' | ':' | '/' | '"' | '\'' | '“' | '”'
            )
        })
        .trim()
        .to_string()
}

fn is_generic_youtube_artist(value: &str) -> bool {
    matches!(value.to_ascii_lowercase().as_str(), "youtube" | "vevo")
}

fn subtitle_priority(path: &Path, preferred_language: &str) -> usize {
    let file_name = path
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let priorities = [
        preferred_language.to_string(),
        "en".to_string(),
        "zh-hans".to_string(),
        "zh-hant".to_string(),
        "zh".to_string(),
        "ja".to_string(),
        "ko".to_string(),
    ];

    priorities
        .iter()
        .position(|language| file_name.contains(&format!(".{language}.")))
        .unwrap_or(priorities.len())
}

fn extract_language_tag(file_name: &str) -> Option<String> {
    let segments = file_name.split('.').collect::<Vec<_>>();
    if segments.len() < 3 {
        return None;
    }
    segments
        .get(segments.len().saturating_sub(2))
        .map(|value| (*value).to_string())
}

fn sanitize_segment(value: &str) -> String {
    sanitize_filename::sanitize(value)
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        .collect::<String>()
        .trim_matches('_')
        .chars()
        .take(80)
        .collect()
}

fn replace_file(source_path: &Path, target_path: &Path) -> Result<()> {
    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    if target_path.exists() {
        std::fs::remove_file(target_path)
            .with_context(|| format!("failed to remove {}", target_path.display()))?;
    }

    match std::fs::rename(source_path, target_path) {
        Ok(()) => Ok(()),
        Err(_) => {
            std::fs::copy(source_path, target_path).with_context(|| {
                format!(
                    "failed to copy {} to {}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
            std::fs::remove_file(source_path)
                .with_context(|| format!("failed to remove {}", source_path.display()))?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_audio_download_args, build_subtitle_download_args, classify_subtitle_warning,
        convert_search_result, download_identity, extract_video_id,
        infer_artist_title_from_video_title, load_subtitle_lyrics, meaningful_lyric_line_count,
        normalize_youtube_url, parse_search_entry, resolve_input_url, search_request_limit,
        search_results_from_json_lines, search_results_from_payload, LyricsIdentity,
    };
    use crate::types::{DownloadYoutubeRequest, LyricLine};
    use std::path::Path;

    fn assert_option_value(args: &[String], option: &str, expected_value: &str) {
        let option_index = args
            .iter()
            .position(|arg| arg == option)
            .unwrap_or_else(|| panic!("missing option {option}"));
        assert_eq!(
            args.get(option_index + 1).map(String::as_str),
            Some(expected_value)
        );
    }

    #[test]
    fn extracts_video_id_from_watch_url() {
        assert_eq!(
            extract_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&ab_channel=RickAstley"),
            Some("dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn prefers_video_id_for_download_identity() {
        let request = DownloadYoutubeRequest {
            video_id: Some("dQw4w9WgXcQ".to_string()),
            url: Some("https://youtu.be/ignored12345".to_string()),
            title: None,
            preferred_language: None,
        };
        assert_eq!(download_identity(&request), Some("dQw4w9WgXcQ".to_string()));
    }

    #[test]
    fn falls_back_to_parsed_video_id_for_download_identity() {
        let request = DownloadYoutubeRequest {
            video_id: None,
            url: Some("https://youtu.be/dQw4w9WgXcQ?t=43".to_string()),
            title: None,
            preferred_language: None,
        };
        assert_eq!(download_identity(&request), Some("dQw4w9WgXcQ".to_string()));
    }

    #[test]
    fn keeps_full_search_result_url() {
        assert_eq!(
            normalize_youtube_url(
                Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string()),
                "fallback"
            ),
            Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn expands_search_result_video_id_url() {
        assert_eq!(
            normalize_youtube_url(Some("dQw4w9WgXcQ".to_string()), "fallback"),
            Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ".to_string())
        );
    }

    #[test]
    fn resolves_download_input_from_video_id_first() {
        let request = DownloadYoutubeRequest {
            video_id: Some("dQw4w9WgXcQ".to_string()),
            url: Some("https://www.youtube.com/watch?v=https://bad.example".to_string()),
            title: None,
            preferred_language: None,
        };
        assert_eq!(
            resolve_input_url(&request).expect("resolve input url"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        );
    }

    #[test]
    fn rejects_non_youtube_download_url() {
        let request = DownloadYoutubeRequest {
            video_id: None,
            url: Some("https://example.com/dQw4w9WgXcQ".to_string()),
            title: None,
            preferred_language: None,
        };

        assert!(resolve_input_url(&request).is_err());
        assert_eq!(download_identity(&request), None);
    }

    #[test]
    fn skips_null_search_entries() {
        assert!(parse_search_entry(serde_json::Value::Null).is_none());
    }

    #[test]
    fn converts_search_result_with_unknown_duration() {
        let item = parse_search_entry(serde_json::json!({
            "id": "dQw4w9WgXcQ",
            "title": "Example",
            "url": "dQw4w9WgXcQ",
            "channel": "Channel",
            "duration": null,
            "thumbnails": [
                { "url": "small.jpg", "width": 120, "height": 90 },
                { "url": "large.jpg", "width": 720, "height": 404 }
            ]
        }))
        .expect("parse item");
        let result = convert_search_result(item).expect("convert item");

        assert_eq!(result.duration_ms, None);
        assert_eq!(result.thumbnail_url, Some("large.jpg".to_string()));
    }

    #[test]
    fn search_request_limit_fetches_extra_video_candidates() {
        assert_eq!(search_request_limit(10), 20);
        assert_eq!(search_request_limit(20), 40);
        assert_eq!(search_request_limit(1), 2);
    }

    #[test]
    fn search_payload_filters_non_video_results_and_limits_output() {
        let payload = serde_json::json!({
            "entries": [
                {
                    "id": "UC8CU5nVhCQIdAGrFFp4loOQ",
                    "title": "Channel",
                    "url": "https://www.youtube.com/channel/UC8CU5nVhCQIdAGrFFp4loOQ",
                    "ie_key": "YoutubeTab"
                },
                {
                    "id": "a7ziV-RjqBo",
                    "title": "Jay Chou",
                    "url": "https://www.youtube.com/watch?v=a7ziV-RjqBo",
                    "channel": "Jay Chou",
                    "duration": 263
                },
                {
                    "id": "ZLldhJXp7iw",
                    "title": "Aegean Sea",
                    "url": "ZLldhJXp7iw",
                    "channel": "Jay Chou",
                    "duration": 217
                }
            ]
        });

        let results = search_results_from_payload(payload, 1).expect("search results");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "a7ziV-RjqBo");
    }

    #[test]
    fn search_json_lines_parses_partial_results() {
        let output = br#"{"id":"bad","title":"Channel","url":"https://www.youtube.com/channel/example","ie_key":"YoutubeTab"}
{"id":"a7ziV-RjqBo","title":"Jay Chou","url":"https://www.youtube.com/watch?v=a7ziV-RjqBo","channel":"Jay Chou","duration":263}
not-json
{"id":"ZLldhJXp7iw","title":"Aegean Sea","url":"ZLldhJXp7iw","channel":"Jay Chou","duration":217}
"#;

        let results = search_results_from_json_lines(output, 3).expect("json lines results");

        assert_eq!(results.len(), 2);
        assert_eq!(
            results[0].webpage_url,
            "https://www.youtube.com/watch?v=a7ziV-RjqBo"
        );
        assert_eq!(
            results[1].webpage_url,
            "https://www.youtube.com/watch?v=ZLldhJXp7iw"
        );
    }

    #[test]
    fn build_audio_download_args_excludes_subtitle_flags() {
        let args = build_audio_download_args(
            "/tmp/ffmpeg",
            Path::new("/tmp/musicx-download"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        );

        assert!(!args.iter().any(|arg| arg == "--write-subs"));
        assert!(!args.iter().any(|arg| arg == "--write-auto-subs"));
        assert!(!args.iter().any(|arg| arg == "--sub-langs"));
        assert!(args.iter().any(|arg| arg == "--write-thumbnail"));
        assert!(args.iter().any(|arg| arg == "--audio-format"));
        assert_option_value(&args, "--format", "bestaudio/best");
        assert_option_value(&args, "--audio-quality", "320K");
    }

    #[test]
    fn build_subtitle_download_args_only_fetches_subtitles() {
        let args = build_subtitle_download_args(
            Path::new("/tmp/musicx-download"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            Some("zh-Hans"),
        );

        assert!(args.iter().any(|arg| arg == "--skip-download"));
        assert!(args.iter().any(|arg| arg == "--write-subs"));
        assert!(args.iter().any(|arg| arg == "--write-auto-subs"));
        assert!(args.iter().any(|arg| arg == "--sub-langs"));
        assert!(!args.iter().any(|arg| arg == "--audio-format"));
    }

    #[test]
    fn infers_artist_and_title_from_lyrics_video_title() {
        assert_eq!(
            infer_artist_title_from_video_title("Taylor Swift - Welcome To New York (Lyrics)"),
            Some(LyricsIdentity {
                artist: "Taylor Swift".to_string(),
                title: "Welcome To New York".to_string(),
            })
        );
    }

    #[test]
    fn treats_music_only_subtitles_as_sparse_for_remote_fallback() {
        let lines = vec![
            LyricLine {
                start_ms: 0,
                end_ms: Some(1_000),
                text: "[Music]".to_string(),
                secondary_text: None,
                confidence: 0.8,
            },
            LyricLine {
                start_ms: 1_000,
                end_ms: Some(2_000),
                text: "[Applause]".to_string(),
                secondary_text: None,
                confidence: 0.8,
            },
        ];

        assert_eq!(meaningful_lyric_line_count(&lines), 0);
    }

    #[test]
    fn chinese_subtitle_preference_checks_chinese_before_english() {
        let args = build_subtitle_download_args(
            Path::new("/tmp/musicx-download"),
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            Some("zh"),
        );
        let language_index = args
            .iter()
            .position(|arg| arg == "--sub-langs")
            .expect("language arg");
        let languages = args
            .get(language_index + 1)
            .expect("language list")
            .split(',')
            .collect::<Vec<_>>();

        let zh_hans = languages
            .iter()
            .position(|language| *language == "zh-Hans.*")
            .expect("zh-Hans preference");
        let english = languages
            .iter()
            .position(|language| *language == "en.*")
            .expect("english fallback");

        assert!(zh_hans < english);
    }

    #[test]
    fn classifies_subtitle_429_as_recoverable_warning() {
        let warning = classify_subtitle_warning(
            "ERROR: Unable to download video subtitles for 'zh-Hans': HTTP Error 429: Too Many Requests",
        )
        .expect("subtitle warning");

        assert!(warning.contains("zh-Hans"));
        assert!(warning.contains("HTTP Error 429"));
    }

    #[test]
    fn does_not_classify_audio_download_error_as_recoverable() {
        assert!(classify_subtitle_warning(
            "ERROR: requested format is not available for this video"
        )
        .is_none());
    }

    #[test]
    fn loads_available_subtitle_even_if_preferred_missing() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let subtitle_path = temp_dir.path().join("dQw4w9WgXcQ.en.vtt");
        std::fs::write(
            subtitle_path,
            "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello from the subtitle\n",
        )
        .expect("write subtitle");

        let lyrics = load_subtitle_lyrics(temp_dir.path(), Some("zh-Hans"), Some(2_000))
            .expect("load subtitles")
            .expect("lyrics document");

        assert_eq!(lyrics.lang.as_deref(), Some("en"));
        assert_eq!(lyrics.lines.len(), 1);
        assert_eq!(lyrics.lines[0].text, "Hello from the subtitle");
    }
}
