use crate::types::LyricLine;
use regex::Regex;

pub fn parse_lrc(raw: &str, duration_ms: Option<i64>) -> Option<Vec<LyricLine>> {
    let timestamp = Regex::new(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]").ok()?;
    let offset = Regex::new(r"^\[offset:([+-]?\d+)\]\s*$").ok()?;
    let mut offset_ms = 0_i64;
    let mut lines = Vec::new();

    for raw_line in raw.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if let Some(caps) = offset.captures(trimmed) {
            offset_ms = caps
                .get(1)
                .and_then(|m| m.as_str().parse::<i64>().ok())
                .unwrap_or(0);
            continue;
        }

        let matches: Vec<_> = timestamp.captures_iter(trimmed).collect();
        if matches.is_empty() {
            continue;
        }

        let text = timestamp.replace_all(trimmed, "").trim().to_string();
        if text.is_empty() {
            continue;
        }

        for item in matches {
            let minutes = item.get(1)?.as_str().parse::<i64>().ok()?;
            let seconds = item.get(2)?.as_str().parse::<i64>().ok()?;
            let fraction = item.get(3).map(|m| m.as_str()).unwrap_or("0");
            let fraction_ms = match fraction.len() {
                0 => 0,
                1 => fraction.parse::<i64>().ok()? * 100,
                2 => fraction.parse::<i64>().ok()? * 10,
                _ => fraction[..3].parse::<i64>().ok()?,
            };
            let start_ms = minutes * 60_000 + seconds * 1_000 + fraction_ms + offset_ms;

            lines.push(LyricLine {
                start_ms,
                end_ms: None,
                text: text.clone(),
                secondary_text: None,
                confidence: 0.95,
            });
        }
    }

    finalize_lines(lines, duration_ms)
}

pub fn parse_plain_text(raw: &str, duration_ms: Option<i64>) -> Option<Vec<LyricLine>> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }

    Some(vec![LyricLine {
        start_ms: 0,
        end_ms: duration_ms,
        text: text.to_string(),
        secondary_text: None,
        confidence: 0.4,
    }])
}

pub fn parse_vtt(raw: &str, duration_ms: Option<i64>) -> Option<Vec<LyricLine>> {
    parse_caption_body(raw, duration_ms)
}

pub fn parse_srt(raw: &str, duration_ms: Option<i64>) -> Option<Vec<LyricLine>> {
    parse_caption_body(raw, duration_ms)
}

fn parse_caption_body(raw: &str, duration_ms: Option<i64>) -> Option<Vec<LyricLine>> {
    let arrow =
        Regex::new(r"(\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(\d{2}:)?\d{2}:\d{2}[.,]\d{3}").ok()?;
    if !arrow.is_match(raw) {
        return None;
    }

    let mut lines = Vec::new();
    let blocks = normalize_caption_newlines(raw);
    let caption_lines = blocks.lines().collect::<Vec<_>>();
    let mut index = 0;

    while index < caption_lines.len() {
        let time_line = caption_lines[index].trim();
        if !time_line.contains("-->") {
            index += 1;
            continue;
        }

        let Some((start_ms, end_ms)) = parse_caption_timing(time_line) else {
            index += 1;
            continue;
        };

        index += 1;
        let mut text_parts = Vec::new();
        while index < caption_lines.len() {
            let next_line = caption_lines[index].trim();
            if next_line.contains("-->") {
                break;
            }

            index += 1;
            if next_line.is_empty() {
                if !text_parts.is_empty() {
                    break;
                }
                continue;
            }

            if is_caption_metadata_line(next_line) {
                continue;
            }

            let text = clean_caption_text(next_line);
            if !text.is_empty() {
                text_parts.push(text);
            }
        }

        if text_parts.is_empty() {
            continue;
        }

        lines.push(LyricLine {
            start_ms,
            end_ms: Some(end_ms),
            text: text_parts.join(" "),
            secondary_text: None,
            confidence: 0.82,
        });
    }

    finalize_lines(lines, duration_ms)
}

fn finalize_lines(mut lines: Vec<LyricLine>, duration_ms: Option<i64>) -> Option<Vec<LyricLine>> {
    if lines.is_empty() {
        return None;
    }

    lines.sort_by_key(|line| line.start_ms);
    let total = lines.len();
    for index in 0..total {
        if lines[index].end_ms.is_none() {
            lines[index].end_ms = lines
                .get(index + 1)
                .map(|line| line.start_ms)
                .or(duration_ms);
        }
    }

    Some(lines)
}

fn normalize_caption_newlines(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    if normalized.matches('\n').count() < 2 && normalized.contains("\\n") {
        normalized.replace("\\r\\n", "\n").replace("\\n", "\n")
    } else {
        normalized
    }
}

fn parse_caption_timing(line: &str) -> Option<(i64, i64)> {
    let mut parts = line.split("-->").map(str::trim);
    let start_ms = parse_caption_timestamp(parts.next()?)?;
    let end_ms = parse_caption_timestamp(parts.next()?)?;
    if end_ms < start_ms {
        return None;
    }

    Some((start_ms, end_ms))
}

fn is_caption_metadata_line(line: &str) -> bool {
    matches!(line, "WEBVTT" | "STYLE" | "REGION")
        || line.starts_with("NOTE")
        || line.starts_with("Kind:")
        || line.starts_with("Language:")
}

fn parse_caption_timestamp(value: &str) -> Option<i64> {
    let timestamp = Regex::new(r"(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{1,3})").ok()?;
    let captures = timestamp.captures(value.trim())?;
    let hours = captures
        .get(1)
        .map(|match_| match_.as_str().parse::<i64>().ok())
        .unwrap_or(Some(0))?;
    let minutes = captures.get(2)?.as_str().parse::<i64>().ok()?;
    let seconds = captures.get(3)?.as_str().parse::<i64>().ok()?;
    let fraction = captures.get(4).map(|match_| match_.as_str()).unwrap_or("0");
    let fraction_ms = match fraction.len() {
        0 => 0,
        1 => fraction.parse::<i64>().ok()? * 100,
        2 => fraction.parse::<i64>().ok()? * 10,
        _ => fraction[..3].parse::<i64>().ok()?,
    };

    Some((hours * 3_600_000) + (minutes * 60_000) + (seconds * 1_000) + fraction_ms)
}

fn clean_caption_text(value: &str) -> String {
    let timing = Regex::new(r"<\d{2}:\d{2}:\d{2}[.,]\d{3}>").ok();
    let tags = Regex::new(r"</?[^>]+>").ok();
    let text = timing
        .as_ref()
        .map(|pattern| pattern.replace_all(value, "").to_string())
        .unwrap_or_else(|| value.to_string());
    let text = tags
        .as_ref()
        .map(|pattern| pattern.replace_all(&text, "").to_string())
        .unwrap_or(text);

    text.replace("<i>", "")
        .replace("</i>", "")
        .replace("<b>", "")
        .replace("</b>", "")
        .replace("&amp;", "&")
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .trim()
        .trim_start_matches('-')
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::{parse_lrc, parse_vtt};

    #[test]
    fn parses_lrc_lines() {
        let raw = "[00:01.00][00:03.50]hello\n[00:05.00]world";
        let lines = parse_lrc(raw, Some(8_000)).expect("expected lrc lines");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].start_ms, 1_000);
        assert_eq!(lines[1].start_ms, 3_500);
        assert_eq!(lines[2].end_ms, Some(8_000));
    }

    #[test]
    fn parses_vtt_lines() {
        let raw = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world\n";
        let lines = parse_vtt(raw, Some(4_000)).expect("expected vtt lines");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].text, "Hello world");
    }

    #[test]
    fn parses_youtube_vtt_with_cue_settings_and_inline_tags() {
        let raw = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:58.359 --> 00:01:01.130 align:start position:0%\nfor<00:00:59.359><c> G</c>\n\n00:01:01.140 --> 00:01:04.549 align:start position:0%\nfor G [Music]\n";
        let lines = parse_vtt(raw, Some(70_000)).expect("expected youtube vtt lines");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].start_ms, 58_359);
        assert_eq!(lines[0].end_ms, Some(61_130));
        assert_eq!(lines[0].text, "for G");
    }
}
