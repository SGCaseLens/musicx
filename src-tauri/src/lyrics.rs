use crate::subtitles::{parse_lrc, parse_plain_text, parse_srt, parse_vtt};
use crate::types::{LyricLine, LyricsDocument};
use anyhow::{anyhow, Result};
use regex::Regex;
use reqwest::StatusCode;
use serde::Deserialize;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct LyricsQuery {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrcLibItem {
    track_name: String,
    artist_name: String,
    album_name: Option<String>,
    duration: Option<f64>,
    plain_lyrics: Option<String>,
    synced_lyrics: Option<String>,
}

pub fn parse_lyrics_document(
    source_kind: &str,
    provider: &str,
    raw: &str,
    duration_ms: Option<i64>,
    language: Option<String>,
    confidence: f32,
) -> Option<LyricsDocument> {
    let synced_lines = parse_lrc(raw, duration_ms)
        .or_else(|| parse_vtt(raw, duration_ms))
        .or_else(|| parse_srt(raw, duration_ms));
    let lines = if source_kind == "youtube_subtitle" {
        synced_lines?
    } else {
        synced_lines.or_else(|| parse_plain_text(raw, duration_ms))?
    };

    Some(LyricsDocument {
        source_kind: source_kind.to_string(),
        provider: provider.to_string(),
        lang: language,
        raw_text: Some(raw.to_string()),
        is_synced: is_synced_lines(&lines),
        confidence,
        source_duration_ms: duration_ms,
        global_offset_ms: 0,
        lines,
    })
}

pub fn repair_synced_lyrics_document(
    document: &LyricsDocument,
    duration_ms: Option<i64>,
) -> Option<LyricsDocument> {
    let raw = document.raw_text.as_deref()?;
    if !looks_like_timed_text(raw) {
        return None;
    }

    let lines = parse_lrc(raw, duration_ms)
        .or_else(|| parse_vtt(raw, duration_ms))
        .or_else(|| parse_srt(raw, duration_ms))?;
    if !is_synced_lines(&lines) {
        return None;
    }

    let mut repaired = document.clone();
    repaired.lines = lines;
    repaired.is_synced = true;
    repaired.source_duration_ms = duration_ms.or(document.source_duration_ms);
    repaired.confidence = repaired.confidence.max(0.86);
    repaired.lang = repaired
        .lang
        .or_else(|| guess_language_from_lines(&repaired.lines));
    Some(repaired)
}

fn looks_like_timed_text(raw: &str) -> bool {
    raw.contains("-->")
        || raw.contains("WEBVTT")
        || Regex::new(r"\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]")
            .ok()
            .is_some_and(|pattern| pattern.is_match(raw))
}

pub async fn search_remote_lyrics(query: &LyricsQuery) -> Result<Option<LyricsDocument>> {
    if query.title.trim().is_empty() || query.artist.trim().is_empty() {
        return Ok(None);
    }

    let client = reqwest::Client::builder()
        .user_agent("musicx/0.1")
        .timeout(Duration::from_secs(8))
        .build()?;

    if let Some(document) = get_exact_match(&client, query).await? {
        return Ok(Some(document));
    }

    search_candidates(&client, query).await
}

pub fn guess_language_from_lines(lines: &[LyricLine]) -> Option<String> {
    let content = lines
        .iter()
        .map(|line| line.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if content.trim().is_empty() {
        return None;
    }

    let contains_cjk = content.chars().any(|value| {
        ('\u{4E00}'..='\u{9FFF}').contains(&value) || ('\u{3040}'..='\u{30FF}').contains(&value)
    });
    if contains_cjk {
        Some("zh-CN".to_string())
    } else {
        Some("en".to_string())
    }
}

pub async fn load_best_local_lyrics(
    sidecar_files: &[std::path::PathBuf],
    embedded: Option<&str>,
    duration_ms: Option<i64>,
) -> Result<Option<LyricsDocument>> {
    for path in sidecar_files {
        if !path.exists() {
            continue;
        }
        let raw = tokio::fs::read_to_string(path).await?;
        if let Some(document) =
            parse_lyrics_document("sidecar", "local", &raw, duration_ms, None, 0.98)
        {
            return Ok(Some(document));
        }
    }

    if let Some(embedded) = embedded {
        if let Some(document) =
            parse_lyrics_document("embedded", "metadata", embedded, duration_ms, None, 0.85)
        {
            return Ok(Some(document));
        }
    }

    Ok(None)
}

pub fn build_lyrics_query(
    title: &str,
    artist: &str,
    album: Option<String>,
    duration_ms: Option<i64>,
) -> Result<LyricsQuery> {
    if title.trim().is_empty() || artist.trim().is_empty() {
        return Err(anyhow!("missing title or artist for lyrics search"));
    }

    Ok(LyricsQuery {
        title: title.to_string(),
        artist: artist.to_string(),
        album,
        duration_ms,
    })
}

async fn get_exact_match(
    client: &reqwest::Client,
    query: &LyricsQuery,
) -> Result<Option<LyricsDocument>> {
    let mut request = client.get("https://lrclib.net/api/get").query(&[
        ("track_name", query.title.as_str()),
        ("artist_name", query.artist.as_str()),
    ]);

    if let Some(album) = query.album.as_deref() {
        request = request.query(&[("album_name", album)]);
    }

    if let Some(duration_ms) = query.duration_ms {
        let duration = format!("{:.0}", duration_ms as f64 / 1_000.0);
        request = request.query(&[("duration", duration.as_str())]);
    }

    let response = request.send().await?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }

    let item: LrcLibItem = response.error_for_status()?.json().await?;
    Ok(convert_candidate(item, query))
}

async fn search_candidates(
    client: &reqwest::Client,
    query: &LyricsQuery,
) -> Result<Option<LyricsDocument>> {
    let response = client
        .get("https://lrclib.net/api/search")
        .query(&[
            ("track_name", query.title.as_str()),
            ("artist_name", query.artist.as_str()),
        ])
        .send()
        .await?;

    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }

    let items: Vec<LrcLibItem> = response.error_for_status()?.json().await?;
    let best = items
        .into_iter()
        .filter_map(|item| {
            let score = score_candidate(query, &item);
            if score >= 0.45 {
                Some((score, item))
            } else {
                None
            }
        })
        .max_by(|left, right| left.0.total_cmp(&right.0))
        .map(|(_, item)| item);

    Ok(best.and_then(|item| convert_candidate(item, query)))
}

fn convert_candidate(item: LrcLibItem, query: &LyricsQuery) -> Option<LyricsDocument> {
    let duration_ms = item
        .duration
        .map(|value| (value * 1_000.0) as i64)
        .or(query.duration_ms);
    let raw = item
        .synced_lyrics
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or(item.plain_lyrics.as_deref())
        .filter(|value| !value.trim().is_empty())?;

    let confidence = if item.synced_lyrics.is_some() {
        0.93
    } else {
        0.62
    };
    parse_lyrics_document("remote", "lrclib", raw, duration_ms, None, confidence)
}

fn score_candidate(query: &LyricsQuery, item: &LrcLibItem) -> f32 {
    let title = normalized_similarity(&query.title, &item.track_name);
    let artist = normalized_similarity(&query.artist, &item.artist_name);
    let album = match (&query.album, &item.album_name) {
        (Some(left), Some(right)) => normalized_similarity(left, right),
        _ => 0.5,
    };
    let duration = match (query.duration_ms, item.duration) {
        (Some(left), Some(right)) => {
            let delta = (left - (right * 1_000.0) as i64).unsigned_abs() as f32;
            (1.0 - (delta / 8_000.0)).clamp(0.0, 1.0)
        }
        _ => 0.5,
    };

    (title * 0.4) + (artist * 0.35) + (album * 0.1) + (duration * 0.15)
}

fn normalized_similarity(left: &str, right: &str) -> f32 {
    let noise =
        Regex::new(r"\b(remaster(?:ed)?|official|audio|video|lyrics?|feat\.?|ft\.?|mv|live)\b")
            .ok();
    let non_word = Regex::new(r"[^\p{L}\p{N}]+").ok();
    let normalize = |value: &str| -> String {
        let lowercase = value.to_lowercase();
        let stripped = noise
            .as_ref()
            .map(|pattern| pattern.replace_all(&lowercase, " ").to_string())
            .unwrap_or(lowercase);
        let clean = non_word
            .as_ref()
            .map(|pattern| pattern.replace_all(&stripped, " ").to_string())
            .unwrap_or(stripped);
        clean.split_whitespace().collect::<Vec<_>>().join(" ")
    };

    let left = normalize(left);
    let right = normalize(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    if left == right {
        return 1.0;
    }
    if left.contains(&right) || right.contains(&left) {
        return 0.88;
    }

    let left_tokens = left.split_whitespace().collect::<Vec<_>>();
    let right_tokens = right.split_whitespace().collect::<Vec<_>>();
    let matches = left_tokens
        .iter()
        .filter(|token| right_tokens.contains(token))
        .count() as f32;
    let max_len = left_tokens.len().max(right_tokens.len()) as f32;
    (matches / max_len).clamp(0.0, 1.0)
}

fn is_synced_lines(lines: &[LyricLine]) -> bool {
    lines.len() > 1 && lines.iter().any(|line| line.start_ms > 0)
}

#[cfg(test)]
mod tests {
    use super::{parse_lyrics_document, repair_synced_lyrics_document};
    use crate::types::{LyricLine, LyricsDocument};

    #[test]
    fn youtube_subtitle_does_not_fall_back_to_plain_text() {
        assert!(parse_lyrics_document(
            "youtube_subtitle",
            "youtube",
            "WEBVTT without usable cues",
            Some(10_000),
            Some("en".to_string()),
            0.87,
        )
        .is_none());
    }

    #[test]
    fn repairs_plain_text_vtt_document_into_synced_lines() {
        let raw = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:03.890 --> 00:00:28.950 align:start position:0%\n[Music]\n\n00:00:58.359 --> 00:01:01.130 align:start position:0%\nfor<00:00:59.359><c> G</c>\n";
        let document = LyricsDocument {
            source_kind: "youtube_subtitle".to_string(),
            provider: "youtube".to_string(),
            lang: Some("en".to_string()),
            raw_text: Some(raw.to_string()),
            is_synced: false,
            confidence: 0.4,
            source_duration_ms: Some(70_000),
            global_offset_ms: 0,
            lines: vec![LyricLine {
                start_ms: 0,
                end_ms: Some(70_000),
                text: raw.to_string(),
                secondary_text: None,
                confidence: 0.4,
            }],
        };

        let repaired =
            repair_synced_lyrics_document(&document, Some(70_000)).expect("repaired lyrics");

        assert!(repaired.is_synced);
        assert_eq!(repaired.lines.len(), 2);
        assert_eq!(repaired.lines[1].start_ms, 58_359);
        assert_eq!(repaired.lines[1].text, "for G");
    }
}
