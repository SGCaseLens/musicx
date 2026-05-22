use crate::lyrics::{
    build_lyrics_query, guess_language_from_lines, load_best_local_lyrics,
    repair_synced_lyrics_document, search_remote_lyrics,
};
use crate::types::{ImportResult, LyricsDocument, Track};
use anyhow::{Context, Result};
use blake3::Hasher;
use chrono::Utc;
use lofty::{
    file::{AudioFile, TaggedFileExt},
    prelude::Accessor,
    probe::Probe,
    tag::ItemKey,
};
use rusqlite::{params, Connection};
use sanitize_filename::sanitize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub struct YoutubeTrackInput {
    pub file_path: PathBuf,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: i64,
    pub cover_art_path: Option<String>,
    pub youtube_video_id: Option<String>,
    pub youtube_url: Option<String>,
    pub lyrics: Option<LyricsDocument>,
}

pub fn init_database(connection: &Connection) -> Result<()> {
    connection.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY,
            source_kind TEXT NOT NULL,
            title TEXT NOT NULL,
            artist TEXT NOT NULL,
            album TEXT,
            duration_ms INTEGER NOT NULL,
            file_path TEXT NOT NULL UNIQUE,
            original_path TEXT,
            cover_art_path TEXT,
            language TEXT,
            youtube_video_id TEXT,
            youtube_url TEXT,
            lyrics_json TEXT,
            is_favorite INTEGER NOT NULL DEFAULT 0,
            play_count INTEGER NOT NULL DEFAULT 0,
            last_played_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tracks_updated_at ON tracks(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tracks_last_played_at ON tracks(last_played_at DESC);
        CREATE INDEX IF NOT EXISTS idx_tracks_favorite ON tracks(is_favorite, title COLLATE NOCASE);
        "#,
    )?;
    ensure_column(connection, "is_favorite", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(connection, "play_count", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(connection, "last_played_at", "TEXT")?;
    Ok(())
}

fn ensure_column(connection: &Connection, column: &str, definition: &str) -> Result<()> {
    let mut statement = connection.prepare("PRAGMA table_info(tracks)")?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }

    connection.execute(
        &format!("ALTER TABLE tracks ADD COLUMN {column} {definition}"),
        [],
    )?;
    Ok(())
}

pub fn open_connection(db_path: &Path) -> Result<Connection> {
    let connection = Connection::open(db_path)?;
    init_database(&connection)?;
    Ok(connection)
}

pub fn list_tracks(connection: &Connection) -> Result<Vec<Track>> {
    let mut statement = connection.prepare(
        r#"
        SELECT
            id, source_kind, title, artist, album, duration_ms, file_path, original_path,
            cover_art_path, language, youtube_video_id, youtube_url, lyrics_json,
            is_favorite, play_count, last_played_at, created_at, updated_at
        FROM tracks
        ORDER BY updated_at DESC, title COLLATE NOCASE ASC
        "#,
    )?;

    let rows = statement.query_map([], map_track_row)?;
    let mut tracks = rows
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(anyhow::Error::from)?;
    drop(statement);
    repair_stored_lyrics(connection, &mut tracks)?;
    Ok(tracks)
}

pub fn get_track_by_id(connection: &Connection, track_id: &str) -> Result<Option<Track>> {
    let mut statement = connection.prepare(
        r#"
        SELECT
            id, source_kind, title, artist, album, duration_ms, file_path, original_path,
            cover_art_path, language, youtube_video_id, youtube_url, lyrics_json,
            is_favorite, play_count, last_played_at, created_at, updated_at
        FROM tracks
        WHERE id = ?1
        LIMIT 1
        "#,
    )?;

    let track = statement.query_row([track_id], map_track_row);
    match track {
        Ok(track) => Ok(Some(track)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn get_track_by_youtube_video_id(
    connection: &Connection,
    video_id: &str,
) -> Result<Option<Track>> {
    let mut statement = connection.prepare(
        r#"
        SELECT
            id, source_kind, title, artist, album, duration_ms, file_path, original_path,
            cover_art_path, language, youtube_video_id, youtube_url, lyrics_json,
            is_favorite, play_count, last_played_at, created_at, updated_at
        FROM tracks
        WHERE youtube_video_id = ?1
        LIMIT 1
        "#,
    )?;

    let track = statement.query_row([video_id], map_track_row);
    match track {
        Ok(track) => Ok(Some(track)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn delete_track_record(connection: &Connection, track_id: &str) -> Result<Option<Track>> {
    let Some(track) = get_track_by_id(connection, track_id)? else {
        return Ok(None);
    };

    connection.execute("DELETE FROM tracks WHERE id = ?1", [track_id])?;
    Ok(Some(track))
}

pub fn save_track(connection: &Connection, track: &Track) -> Result<()> {
    let lyrics_json = track
        .lyrics
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .context("failed to serialize lyrics")?;

    connection.execute(
        r#"
        INSERT INTO tracks (
            id, source_kind, title, artist, album, duration_ms, file_path, original_path,
            cover_art_path, language, youtube_video_id, youtube_url, lyrics_json,
            is_favorite, play_count, last_played_at, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
        ON CONFLICT(id) DO UPDATE SET
            source_kind = excluded.source_kind,
            title = excluded.title,
            artist = excluded.artist,
            album = excluded.album,
            duration_ms = excluded.duration_ms,
            file_path = excluded.file_path,
            original_path = excluded.original_path,
            cover_art_path = excluded.cover_art_path,
            language = excluded.language,
            youtube_video_id = excluded.youtube_video_id,
            youtube_url = excluded.youtube_url,
            lyrics_json = excluded.lyrics_json,
            is_favorite = excluded.is_favorite,
            play_count = excluded.play_count,
            last_played_at = excluded.last_played_at,
            updated_at = excluded.updated_at
        "#,
        params![
            track.id,
            track.source_kind,
            track.title,
            track.artist,
            track.album,
            track.duration_ms,
            track.file_path,
            track.original_path,
            track.cover_art_path,
            track.language,
            track.youtube_video_id,
            track.youtube_url,
            lyrics_json,
            track.is_favorite,
            track.play_count,
            track.last_played_at,
            track.created_at,
            track.updated_at,
        ],
    )?;

    Ok(())
}

pub fn save_lyrics(connection: &Connection, track_id: &str, lyrics: &LyricsDocument) -> Result<()> {
    let json = serde_json::to_string(lyrics)?;
    connection.execute(
        "UPDATE tracks SET lyrics_json = ?1, language = COALESCE(?2, language), updated_at = ?3 WHERE id = ?4",
        params![json, lyrics.lang, Utc::now().to_rfc3339(), track_id],
    )?;
    Ok(())
}

pub fn update_lyrics_offset(
    connection: &Connection,
    track_id: &str,
    offset_ms: i64,
) -> Result<Option<Track>> {
    let Some(mut track) = get_track_by_id(connection, track_id)? else {
        return Ok(None);
    };
    let Some(mut lyrics) = track.lyrics.clone() else {
        return Ok(Some(track));
    };

    lyrics.global_offset_ms = offset_ms.clamp(-30_000, 30_000);
    let json = serde_json::to_string(&lyrics)?;
    connection.execute(
        "UPDATE tracks SET lyrics_json = ?1, updated_at = ?2 WHERE id = ?3",
        params![json, Utc::now().to_rfc3339(), track_id],
    )?;

    track.lyrics = Some(lyrics);
    Ok(Some(track))
}

pub fn update_track_favorite(
    connection: &Connection,
    track_id: &str,
    is_favorite: bool,
) -> Result<Option<Track>> {
    if get_track_by_id(connection, track_id)?.is_none() {
        return Ok(None);
    }

    connection.execute(
        "UPDATE tracks SET is_favorite = ?1 WHERE id = ?2",
        params![is_favorite, track_id],
    )?;
    get_track_by_id(connection, track_id)
}

pub fn record_track_played(connection: &Connection, track_id: &str) -> Result<Option<Track>> {
    if get_track_by_id(connection, track_id)?.is_none() {
        return Ok(None);
    }

    connection.execute(
        "UPDATE tracks SET play_count = play_count + 1, last_played_at = ?1 WHERE id = ?2",
        params![Utc::now().to_rfc3339(), track_id],
    )?;
    get_track_by_id(connection, track_id)
}

fn repair_stored_lyrics(connection: &Connection, tracks: &mut [Track]) -> Result<()> {
    for track in tracks {
        let Some(repaired) = track
            .lyrics
            .as_ref()
            .and_then(|lyrics| repair_synced_lyrics_document(lyrics, Some(track.duration_ms)))
        else {
            continue;
        };

        let should_replace = track.lyrics.as_ref().is_none_or(|current| {
            current.is_synced != repaired.is_synced || current.lines.len() != repaired.lines.len()
        });
        if !should_replace {
            continue;
        }

        let json = serde_json::to_string(&repaired)?;
        let repaired_lang = repaired.lang.clone();
        connection.execute(
            "UPDATE tracks SET lyrics_json = ?1, language = COALESCE(?2, language) WHERE id = ?3",
            params![json, repaired_lang, track.id.as_str()],
        )?;
        track.language = repaired.lang.clone().or_else(|| track.language.clone());
        track.lyrics = Some(repaired);
    }

    Ok(())
}

pub async fn import_tracks(
    db_path: &Path,
    library_dir: &Path,
    artwork_dir: &Path,
    source_paths: &[String],
) -> Result<ImportResult> {
    let mut imported = 0;
    let mut skipped = 0;
    let mut warnings = Vec::new();
    let mut tracks = Vec::new();

    for source_path in source_paths {
        match import_single_track(db_path, library_dir, artwork_dir, Path::new(source_path)).await {
            Ok(Some(track)) => {
                imported += 1;
                tracks.push(track);
            }
            Ok(None) => skipped += 1,
            Err(error) => {
                skipped += 1;
                warnings.push(format!("{source_path}: {error}"));
            }
        }
    }

    Ok(ImportResult {
        tracks,
        imported,
        skipped,
        warnings,
    })
}

pub fn create_youtube_track(connection: &Connection, input: YoutubeTrackInput) -> Result<Track> {
    let now = Utc::now().to_rfc3339();
    let language = input
        .lyrics
        .as_ref()
        .and_then(|document| document.lang.clone());
    let track = Track {
        id: Uuid::new_v4().to_string(),
        source_kind: "youtube".to_string(),
        title: input.title,
        artist: input.artist,
        album: input.album,
        duration_ms: input.duration_ms,
        file_path: input.file_path.to_string_lossy().to_string(),
        original_path: None,
        cover_art_path: input.cover_art_path,
        language,
        youtube_video_id: input.youtube_video_id,
        youtube_url: input.youtube_url,
        lyrics: input.lyrics,
        is_favorite: false,
        play_count: 0,
        last_played_at: None,
        created_at: now.clone(),
        updated_at: now,
    };
    save_track(connection, &track)?;
    Ok(track)
}

async fn import_single_track(
    db_path: &Path,
    library_dir: &Path,
    artwork_dir: &Path,
    source_path: &Path,
) -> Result<Option<Track>> {
    if !source_path.exists() || !source_path.is_file() {
        return Ok(None);
    }

    let extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if !matches!(
        extension.as_str(),
        "mp3" | "m4a" | "wav" | "flac" | "aac" | "ogg"
    ) {
        return Ok(None);
    }

    {
        let connection = open_connection(db_path)?;
        if let Some(existing) = get_track_by_source(&connection, source_path)? {
            return Ok(Some(existing));
        }
    }

    let tagged = Probe::open(source_path)
        .with_context(|| format!("failed to open {}", source_path.display()))?
        .read()
        .with_context(|| format!("failed to read metadata from {}", source_path.display()))?;
    let properties = tagged.properties();
    let duration_ms = properties.duration().as_millis() as i64;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let title = tag
        .and_then(|tag| tag.title())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            source_path
                .file_stem()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Unknown Title".to_string());
    let artist = tag
        .and_then(|tag| tag.artist())
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Unknown Artist".to_string());
    let album = tag
        .and_then(|tag| tag.album())
        .map(|value| value.to_string());
    let embedded_lyrics = tag
        .and_then(|tag| tag.get_string(ItemKey::Lyrics))
        .map(str::to_string);

    let signature = compute_file_signature(source_path)?;
    let track_id = Uuid::new_v4().to_string();
    let safe_stem = sanitize(format!("{}-{}", title, &track_id[..8]));
    let target_path = library_dir.join(format!("{safe_stem}.{extension}"));
    std::fs::copy(source_path, &target_path)
        .with_context(|| format!("failed to copy {} into library", source_path.display()))?;

    let cover_art_path = extract_cover_art(tag, artwork_dir, &track_id)?;
    let sidecar_files = sidecar_candidates(source_path);
    let mut lyrics = load_best_local_lyrics(
        &sidecar_files,
        embedded_lyrics.as_deref(),
        Some(duration_ms),
    )
    .await?;
    if lyrics.is_none() {
        if let Ok(query) = build_lyrics_query(&title, &artist, album.clone(), Some(duration_ms)) {
            lyrics = search_remote_lyrics(&query).await.unwrap_or(None);
        }
    }

    if let Some(ref mut document) = lyrics {
        document.lang = guess_language_from_lines(&document.lines);
    }

    let now = Utc::now().to_rfc3339();
    let track = Track {
        id: track_id,
        source_kind: "local".to_string(),
        title,
        artist,
        album,
        duration_ms,
        file_path: target_path.to_string_lossy().to_string(),
        original_path: Some(source_path.to_string_lossy().to_string()),
        cover_art_path,
        language: lyrics.as_ref().and_then(|document| document.lang.clone()),
        youtube_video_id: Some(signature),
        youtube_url: None,
        lyrics,
        is_favorite: false,
        play_count: 0,
        last_played_at: None,
        created_at: now.clone(),
        updated_at: now,
    };
    let connection = open_connection(db_path)?;
    save_track(&connection, &track)?;
    Ok(Some(track))
}

fn get_track_by_source(connection: &Connection, source_path: &Path) -> Result<Option<Track>> {
    let mut statement = connection.prepare(
        r#"
        SELECT
            id, source_kind, title, artist, album, duration_ms, file_path, original_path,
            cover_art_path, language, youtube_video_id, youtube_url, lyrics_json, created_at, updated_at
        FROM tracks
        WHERE original_path = ?1 OR file_path = ?1
        LIMIT 1
        "#,
    )?;
    let source = source_path.to_string_lossy().to_string();
    let track = statement.query_row([source], map_track_row);
    match track {
        Ok(track) => Ok(Some(track)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn map_track_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Track> {
    let lyrics_json: Option<String> = row.get(12)?;
    let lyrics = lyrics_json
        .as_deref()
        .and_then(|value| serde_json::from_str::<LyricsDocument>(value).ok());

    Ok(Track {
        id: row.get(0)?,
        source_kind: row.get(1)?,
        title: row.get(2)?,
        artist: row.get(3)?,
        album: row.get(4)?,
        duration_ms: row.get(5)?,
        file_path: row.get(6)?,
        original_path: row.get(7)?,
        cover_art_path: row.get(8)?,
        language: row.get(9)?,
        youtube_video_id: row.get(10)?,
        youtube_url: row.get(11)?,
        lyrics,
        is_favorite: row.get(13)?,
        play_count: row.get(14)?,
        last_played_at: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
    })
}

fn compute_file_signature(path: &Path) -> Result<String> {
    let metadata = std::fs::metadata(path)?;
    let size = metadata.len();
    let mut file = File::open(path)?;
    let mut hasher = Hasher::new();
    let mut buffer = vec![0_u8; 32 * 1024];
    let head = file.read(&mut buffer)?;
    hasher.update(&buffer[..head]);
    if size > buffer.len() as u64 {
        file.seek(SeekFrom::End(-(buffer.len() as i64)))?;
        let tail = file.read(&mut buffer)?;
        hasher.update(&buffer[..tail]);
    }
    Ok(format!("{}:{}", size, hasher.finalize().to_hex()))
}

fn extract_cover_art(
    tag: Option<&lofty::tag::Tag>,
    artwork_dir: &Path,
    track_id: &str,
) -> Result<Option<String>> {
    let Some(tag) = tag else {
        return Ok(None);
    };
    let Some(picture) = tag.pictures().first() else {
        return Ok(None);
    };

    let extension = infer_picture_extension(
        picture.data(),
        picture.mime_type().map(|mime| mime.to_string()).as_deref(),
    );
    let file_path = artwork_dir.join(format!("{track_id}.{extension}"));
    std::fs::write(&file_path, picture.data())?;
    Ok(Some(file_path.to_string_lossy().to_string()))
}

fn sidecar_candidates(source_path: &Path) -> Vec<PathBuf> {
    let stem = source_path.with_extension("");
    ["lrc", "txt", "vtt", "srt"]
        .iter()
        .map(|extension| stem.with_extension(extension))
        .collect()
}

fn infer_picture_extension(bytes: &[u8], mime_type: Option<&str>) -> &'static str {
    if let Some(mime_type) = mime_type {
        if mime_type.contains("png") {
            return "png";
        }
        if mime_type.contains("jpeg") || mime_type.contains("jpg") {
            return "jpg";
        }
        if mime_type.contains("webp") {
            return "webp";
        }
        if mime_type.contains("gif") {
            return "gif";
        }
    }

    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "jpg"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "gif"
    } else {
        "bin"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{LyricLine, LyricsDocument, Track};

    fn test_track(id: &str, file_path: &str) -> Track {
        Track {
            id: id.to_string(),
            source_kind: "local".to_string(),
            title: "Test Track".to_string(),
            artist: "Test Artist".to_string(),
            album: None,
            duration_ms: 1_000,
            file_path: file_path.to_string(),
            original_path: None,
            cover_art_path: None,
            language: None,
            youtube_video_id: None,
            youtube_url: None,
            lyrics: None,
            is_favorite: false,
            play_count: 0,
            last_played_at: None,
            created_at: "2026-04-25T00:00:00Z".to_string(),
            updated_at: "2026-04-25T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn delete_track_record_removes_existing_row() {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        init_database(&connection).expect("init db");
        let track = test_track("track-delete", "/tmp/musicx-delete.mp3");
        save_track(&connection, &track).expect("save track");

        let deleted = delete_track_record(&connection, "track-delete")
            .expect("delete track")
            .expect("deleted track");

        assert_eq!(deleted.id, "track-delete");
        assert!(get_track_by_id(&connection, "track-delete")
            .expect("query deleted track")
            .is_none());
    }

    #[test]
    fn delete_track_record_is_noop_when_missing() {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        init_database(&connection).expect("init db");

        let deleted = delete_track_record(&connection, "missing").expect("delete missing track");

        assert!(deleted.is_none());
    }

    #[test]
    fn update_lyrics_offset_persists_global_offset() {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        init_database(&connection).expect("init db");
        let mut track = test_track("track-offset", "/tmp/musicx-offset.mp3");
        track.lyrics = Some(LyricsDocument {
            source_kind: "manual".to_string(),
            provider: "test".to_string(),
            lang: Some("en".to_string()),
            raw_text: None,
            is_synced: true,
            confidence: 1.0,
            source_duration_ms: Some(track.duration_ms),
            global_offset_ms: 0,
            lines: vec![LyricLine {
                start_ms: 0,
                end_ms: Some(1_000),
                text: "hello".to_string(),
                secondary_text: None,
                confidence: 1.0,
            }],
        });
        save_track(&connection, &track).expect("save track with lyrics");

        let updated = update_lyrics_offset(&connection, "track-offset", 750)
            .expect("update offset")
            .expect("updated track");
        assert_eq!(
            updated
                .lyrics
                .as_ref()
                .map(|lyrics| lyrics.global_offset_ms),
            Some(750),
        );

        let persisted = get_track_by_id(&connection, "track-offset")
            .expect("read persisted track")
            .expect("persisted track");
        assert_eq!(
            persisted
                .lyrics
                .as_ref()
                .map(|lyrics| lyrics.global_offset_ms),
            Some(750),
        );

        let clamped = update_lyrics_offset(&connection, "track-offset", 99_999)
            .expect("clamp offset")
            .expect("clamped track");
        assert_eq!(
            clamped
                .lyrics
                .as_ref()
                .map(|lyrics| lyrics.global_offset_ms),
            Some(30_000),
        );
    }

    #[test]
    fn favorite_and_recent_play_metadata_persist() {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        init_database(&connection).expect("init db");
        let track = test_track("track-library", "/tmp/musicx-library.mp3");
        save_track(&connection, &track).expect("save track");

        let favorited = update_track_favorite(&connection, "track-library", true)
            .expect("favorite track")
            .expect("favorited track");
        assert!(favorited.is_favorite);

        let played = record_track_played(&connection, "track-library")
            .expect("record play")
            .expect("played track");
        assert_eq!(played.play_count, 1);
        assert!(played.last_played_at.is_some());

        let persisted = get_track_by_id(&connection, "track-library")
            .expect("read track")
            .expect("persisted track");
        assert!(persisted.is_favorite);
        assert_eq!(persisted.play_count, 1);
        assert!(persisted.last_played_at.is_some());
    }
}
