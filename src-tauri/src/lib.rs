mod binaries;
mod demo;
mod errors;
mod library;
mod lyrics;
mod paths;
mod state;
mod subtitles;
mod system_volume;
mod types;
mod youtube;

use crate::errors::{AppResult, ErrorPayload};
use crate::library::{
    create_youtube_track, delete_track_record, get_track_by_id, get_track_by_youtube_video_id,
    import_tracks, list_tracks as list_tracks_impl, open_connection, save_lyrics,
    YoutubeTrackInput,
};
use crate::lyrics::{build_lyrics_query, guess_language_from_lines, search_remote_lyrics};
use crate::paths::ensure_app_dirs;
use crate::state::AppState;
use crate::types::{
    BootstrapPayload, DeleteTrackResult, DependencyStatus, DownloadProgressEvent,
    DownloadYoutubeRequest, ImportResult, Track, TrackListPayload, YoutubeSearchResult,
};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[tauri::command]
async fn get_system_output_volume() -> AppResult<f64> {
    system_volume::get_output_volume()
        .await
        .map_err(ErrorPayload::from)
}

#[tauri::command]
async fn set_system_output_volume(volume: f64) -> AppResult<f64> {
    system_volume::set_output_volume(volume)
        .await
        .map_err(ErrorPayload::from)
}

#[tauri::command]
async fn open_library_folder(app: AppHandle) -> AppResult<()> {
    let paths = ensure_app_dirs(&app).map_err(ErrorPayload::from)?;
    open_folder_in_file_manager(&paths.library)?;
    Ok(())
}

fn open_folder_in_file_manager(path: &Path) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("open");
        command.arg(path);
        command
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("explorer");
        command.arg(path);
        command
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(path);
        command
    };

    let status = command.status().map_err(|error| {
        ErrorPayload::new(format!(
            "failed to open library folder {} ({error})",
            path.display()
        ))
    })?;

    if !status.success() {
        return Err(ErrorPayload::new(format!(
            "file manager exited with status {status}"
        )));
    }

    Ok(())
}

#[tauri::command]
async fn bootstrap_app(app: AppHandle) -> AppResult<BootstrapPayload> {
    let paths = ensure_app_dirs(&app).map_err(ErrorPayload::from)?;
    let connection = open_connection(&paths.db).map_err(ErrorPayload::from)?;
    drop(connection);

    let locale = sys_locale::get_locale().unwrap_or_else(|| "en".to_string());
    let yt_dlp_ready = binaries::ensure_yt_dlp(&app).await.is_ok();
    let ffmpeg_ready = binaries::ensure_ffmpeg(&app).await.is_ok();

    Ok(BootstrapPayload {
        locale,
        app_data_dir: paths.root.to_string_lossy().to_string(),
        library_dir: paths.library.to_string_lossy().to_string(),
        dependency_status: DependencyStatus {
            yt_dlp_ready,
            ffmpeg_ready,
        },
    })
}

#[tauri::command]
async fn list_tracks(app: AppHandle) -> AppResult<TrackListPayload> {
    let paths = ensure_app_dirs(&app).map_err(ErrorPayload::from)?;
    let connection = open_connection(&paths.db).map_err(ErrorPayload::from)?;
    let mut tracks = list_tracks_impl(&connection).map_err(ErrorPayload::from)?;

    if !tracks
        .iter()
        .any(|track| track.id == "demo-sunrise-circuit")
    {
        if let Ok(demo_track) = demo::ensure_demo_track(&paths.library, &paths.artwork) {
            tracks.insert(0, demo_track);
        }
    }

    Ok(TrackListPayload { tracks })
}

#[tauri::command]
async fn import_local_tracks(app: AppHandle, paths: Vec<String>) -> AppResult<ImportResult> {
    let app_paths = ensure_app_dirs(&app).map_err(ErrorPayload::from)?;
    import_tracks(
        &app_paths.db,
        &app_paths.library,
        &app_paths.artwork,
        &paths,
    )
    .await
    .map_err(ErrorPayload::from)
}

#[tauri::command]
async fn delete_track(app: AppHandle, track_id: String) -> AppResult<DeleteTrackResult> {
    if track_id == "demo-sunrise-circuit" {
        return Err(ErrorPayload::new("Demo track cannot be deleted"));
    }

    let app_paths = ensure_app_dirs(&app).map_err(ErrorPayload::from)?;
    let connection = open_connection(&app_paths.db).map_err(ErrorPayload::from)?;
    let deleted_track = delete_track_record(&connection, &track_id).map_err(ErrorPayload::from)?;
    drop(connection);

    let Some(track) = deleted_track else {
        return Ok(DeleteTrackResult {
            deleted_track_id: None,
            warnings: Vec::new(),
        });
    };

    let mut warnings = Vec::new();
    remove_managed_file(
        Some(track.file_path.as_str()),
        &app_paths.library,
        "audio",
        &mut warnings,
    );
    remove_managed_file(
        track.cover_art_path.as_deref(),
        &app_paths.artwork,
        "artwork",
        &mut warnings,
    );

    Ok(DeleteTrackResult {
        deleted_track_id: Some(track.id),
        warnings,
    })
}

fn remove_managed_file(
    path_value: Option<&str>,
    allowed_root: &Path,
    label: &str,
    warnings: &mut Vec<String>,
) {
    let Some(path_value) = path_value else {
        return;
    };
    let path = PathBuf::from(path_value);
    if !path.exists() {
        return;
    }

    let root = match allowed_root.canonicalize() {
        Ok(root) => root,
        Err(error) => {
            warnings.push(format!(
                "Skipped deleting {label}: couldn't inspect app directory ({error})"
            ));
            return;
        }
    };
    let target = match path.canonicalize() {
        Ok(target) => target,
        Err(error) if error.kind() == ErrorKind::NotFound => return,
        Err(error) => {
            warnings.push(format!(
                "Skipped deleting {label}: couldn't inspect {} ({error})",
                path.display()
            ));
            return;
        }
    };

    if !target.starts_with(&root) {
        warnings.push(format!(
            "Skipped deleting {label}: {} is outside the app library",
            target.display()
        ));
        return;
    }

    match std::fs::remove_file(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => warnings.push(format!(
            "Removed track from library, but couldn't delete {label} {} ({error})",
            target.display()
        )),
    }
}

#[tauri::command]
async fn search_lyrics_for_track(app: AppHandle, track_id: String) -> AppResult<Option<Track>> {
    let app_paths = ensure_app_dirs(&app).map_err(ErrorPayload::from)?;
    let connection = open_connection(&app_paths.db).map_err(ErrorPayload::from)?;
    let track = get_track_by_id(&connection, &track_id)
        .map_err(ErrorPayload::from)?
        .ok_or_else(|| ErrorPayload::new("track not found"))?;
    if track.lyrics.is_some() {
        return Ok(Some(track));
    }
    drop(connection);

    let (query_title, query_artist) = if track.source_kind == "youtube" {
        youtube::infer_lyrics_lookup_from_youtube_metadata(&track.title, &track.artist)
            .unwrap_or_else(|| (track.title.clone(), track.artist.clone()))
    } else {
        (track.title.clone(), track.artist.clone())
    };
    let query = build_lyrics_query(
        &query_title,
        &query_artist,
        track.album.clone(),
        Some(track.duration_ms),
    )
    .map_err(ErrorPayload::from)?;
    let maybe_lyrics = search_remote_lyrics(&query)
        .await
        .map_err(ErrorPayload::from)?;

    if let Some(mut lyrics) = maybe_lyrics {
        lyrics.lang = lyrics
            .lang
            .or_else(|| guess_language_from_lines(&lyrics.lines));
        let connection = open_connection(&app_paths.db).map_err(ErrorPayload::from)?;
        save_lyrics(&connection, &track.id, &lyrics).map_err(ErrorPayload::from)?;
    }

    let connection = open_connection(&app_paths.db).map_err(ErrorPayload::from)?;
    get_track_by_id(&connection, &track_id).map_err(ErrorPayload::from)
}

#[tauri::command]
async fn search_youtube_videos(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
) -> AppResult<Vec<YoutubeSearchResult>> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(ErrorPayload::new("search query is required"));
    }

    youtube::search_youtube(&app, &query, limit.unwrap_or(12).clamp(1, 20))
        .await
        .map_err(|error| ErrorPayload::new(format!("YouTube search failed: {error}")))
}

#[tauri::command]
async fn download_youtube_audio(
    app: AppHandle,
    state: State<'_, AppState>,
    request: DownloadYoutubeRequest,
) -> AppResult<Track> {
    let identity = youtube::download_identity(&request)
        .ok_or_else(|| ErrorPayload::new("missing video id or url"))?;
    let candidate_video_id = request
        .video_id
        .clone()
        .or_else(|| request.url.as_deref().and_then(youtube::extract_video_id));

    {
        let mut active = state
            .active_downloads
            .lock()
            .map_err(|_| ErrorPayload::new("failed to lock download state"))?;
        if active.contains(&identity) {
            return Err(ErrorPayload::new(
                "download already in progress for this video",
            ));
        }
        active.insert(identity.clone());
    }

    let result = async {
        let app_paths = ensure_app_dirs(&app).map_err(ErrorPayload::from)?;
        if let Some(video_id) = candidate_video_id.as_deref() {
            let connection = open_connection(&app_paths.db).map_err(ErrorPayload::from)?;
            if let Some(track) =
                get_track_by_youtube_video_id(&connection, video_id).map_err(ErrorPayload::from)?
            {
                return Ok(track);
            }
        }

        let task_id = Uuid::new_v4().to_string();
        let downloaded = youtube::download_youtube_audio(&app, &request, &task_id)
            .await
            .map_err(ErrorPayload::from)?;
        let connection = open_connection(&app_paths.db).map_err(ErrorPayload::from)?;
        if let Some(video_id) = downloaded.youtube_video_id.as_deref() {
            if let Some(existing) =
                get_track_by_youtube_video_id(&connection, video_id).map_err(ErrorPayload::from)?
            {
                let _ = app.emit(
                    "youtube-download-progress",
                    DownloadProgressEvent {
                        task_id,
                        video_id: Some(video_id.to_string()),
                        stage: "completed".to_string(),
                        progress: 1.0,
                        message: "YouTube audio already exists in the local library".to_string(),
                        track: Some(existing.clone()),
                    },
                );
                return Ok(existing);
            }
        }
        let track = create_youtube_track(
            &connection,
            YoutubeTrackInput {
                file_path: downloaded.file_path,
                title: downloaded.title,
                artist: downloaded.artist,
                album: downloaded.album,
                duration_ms: downloaded.duration_ms,
                cover_art_path: downloaded.cover_art_path,
                youtube_video_id: downloaded.youtube_video_id.clone(),
                youtube_url: downloaded.youtube_url.clone(),
                lyrics: downloaded.lyrics,
            },
        )
        .map_err(ErrorPayload::from)?;
        let _ = app.emit(
            "youtube-download-progress",
            DownloadProgressEvent {
                task_id,
                video_id: downloaded.youtube_video_id,
                stage: "completed".to_string(),
                progress: 1.0,
                message: "YouTube audio imported into the local library".to_string(),
                track: Some(track.clone()),
            },
        );
        Ok(track)
    }
    .await;

    if let Ok(mut active) = state.active_downloads.lock() {
        active.remove(&identity);
    }

    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    if let Err(error) = window.hide() {
                        eprintln!("failed to hide musicx window: {error}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_system_output_volume,
            set_system_output_volume,
            open_library_folder,
            bootstrap_app,
            list_tracks,
            import_local_tracks,
            delete_track,
            search_lyrics_for_track,
            search_youtube_videos,
            download_youtube_audio
        ]);

    if let Err(error) = app.build(tauri::generate_context!()).map(|app| {
        app.run(|app_handle, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } = event
            {
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
    }) {
        eprintln!("musicx backend failed to start: {error}");
    }
}
