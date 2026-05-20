use crate::types::{LyricLine, LyricsDocument, Track};
use anyhow::{Context, Result};
use std::f32::consts::PI;
use std::path::Path;

const DEMO_TRACK_ID: &str = "demo-sunrise-circuit";
const DEMO_AUDIO_FILE: &str = "musicx-demo-sunrise-circuit.wav";
const DEMO_ARTWORK_FILE: &str = "musicx-demo-cover.png";
const DEMO_CREATED_AT: &str = "2026-04-25T00:00:00Z";
const SAMPLE_RATE: u32 = 44_100;
const CHANNELS: u16 = 1;
const BITS_PER_SAMPLE: u16 = 16;
const BEAT_DURATION_SECONDS: f32 = 0.5;

const DEMO_MELODY_HZ: [f32; 48] = [
    261.63, 329.63, 392.00, 523.25, 392.00, 329.63, 293.66, 261.63, 293.66, 349.23, 440.00, 587.33,
    440.00, 349.23, 329.63, 293.66, 329.63, 392.00, 493.88, 659.25, 493.88, 392.00, 349.23, 329.63,
    293.66, 349.23, 440.00, 587.33, 440.00, 349.23, 329.63, 293.66, 261.63, 329.63, 392.00, 523.25,
    392.00, 329.63, 293.66, 261.63, 220.00, 261.63, 329.63, 440.00, 329.63, 261.63, 246.94, 220.00,
];

const DEMO_LYRICS: [(&str, &str, i64); 8] = [
    (
        "Count the lights before the room turns gold",
        "等灯光把房间慢慢染成金色",
        0,
    ),
    (
        "Small tape hiss and a soft machine heartbeat",
        "磁带底噪和温柔的机器心跳一起响起",
        3_000,
    ),
    (
        "We draw a skyline with a borrowed chord",
        "我们借来一组和弦描出天际线",
        6_000,
    ),
    (
        "Every window answers in the same key",
        "每扇窗都用同一个调回应",
        9_000,
    ),
    (
        "Hold the downbeat, let the color bloom",
        "按住第一拍，让颜色慢慢盛开",
        12_000,
    ),
    (
        "Static rain turns silver on the ceiling",
        "天花板上的静电雨闪着银光",
        15_000,
    ),
    (
        "When the chorus lands, the floor starts to move",
        "副歌落下时，地板也开始轻轻移动",
        18_000,
    ),
    (
        "Sunrise circuit, keep the signal breathing",
        "日出电路，让这道讯号继续呼吸",
        21_000,
    ),
];

pub fn ensure_demo_track(library_dir: &Path, artwork_dir: &Path) -> Result<Track> {
    let audio_path = library_dir.join(DEMO_AUDIO_FILE);
    if !audio_path.exists() {
        write_demo_wav(&audio_path)?;
    }

    let artwork_path = artwork_dir.join(DEMO_ARTWORK_FILE);
    if !artwork_path.exists() {
        std::fs::write(&artwork_path, include_bytes!("../icons/128x128.png"))
            .with_context(|| format!("failed to write {}", artwork_path.display()))?;
    }

    Ok(Track {
        id: DEMO_TRACK_ID.to_string(),
        source_kind: "demo".to_string(),
        title: "Sunrise Circuit".to_string(),
        artist: "musicx demo ensemble".to_string(),
        album: Some("Built-in Examples".to_string()),
        duration_ms: demo_duration_ms(),
        file_path: audio_path.to_string_lossy().to_string(),
        original_path: None,
        cover_art_path: Some(artwork_path.to_string_lossy().to_string()),
        language: Some("en".to_string()),
        youtube_video_id: None,
        youtube_url: None,
        lyrics: Some(build_demo_lyrics()),
        created_at: DEMO_CREATED_AT.to_string(),
        updated_at: DEMO_CREATED_AT.to_string(),
    })
}

fn build_demo_lyrics() -> LyricsDocument {
    let mut lines = Vec::with_capacity(DEMO_LYRICS.len());
    for (index, (text, secondary_text, start_ms)) in DEMO_LYRICS.iter().enumerate() {
        let end_ms = DEMO_LYRICS
            .get(index + 1)
            .map(|(_, _, next_start_ms)| next_start_ms - 350);
        lines.push(LyricLine {
            start_ms: *start_ms,
            end_ms,
            text: (*text).to_string(),
            secondary_text: Some((*secondary_text).to_string()),
            confidence: 1.0,
        });
    }

    LyricsDocument {
        source_kind: "embedded_demo".to_string(),
        provider: "musicx".to_string(),
        lang: Some("en".to_string()),
        raw_text: None,
        is_synced: true,
        confidence: 1.0,
        source_duration_ms: Some(demo_duration_ms()),
        global_offset_ms: 0,
        lines,
    }
}

fn demo_duration_ms() -> i64 {
    ((DEMO_MELODY_HZ.len() as f32) * BEAT_DURATION_SECONDS * 1_000.0) as i64
}

fn write_demo_wav(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }

    let samples = generate_demo_samples();
    let bytes = encode_wav(&samples);
    std::fs::write(path, bytes).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(())
}

fn generate_demo_samples() -> Vec<i16> {
    let total_samples = ((demo_duration_ms() as f32 / 1_000.0) * SAMPLE_RATE as f32) as usize;
    let mut samples = Vec::with_capacity(total_samples);

    for sample_index in 0..total_samples {
        let time = sample_index as f32 / SAMPLE_RATE as f32;
        let beat_index =
            ((time / BEAT_DURATION_SECONDS).floor() as usize).min(DEMO_MELODY_HZ.len() - 1);
        let frequency = DEMO_MELODY_HZ[beat_index];
        let beat_position = (time % BEAT_DURATION_SECONDS) / BEAT_DURATION_SECONDS;
        let envelope = if beat_position < 0.08 {
            beat_position / 0.08
        } else if beat_position > 0.82 {
            ((1.0 - beat_position) / 0.18).max(0.0)
        } else {
            1.0
        };

        let lead = (2.0 * PI * frequency * time).sin();
        let octave = (2.0 * PI * frequency * 2.0 * time).sin() * 0.35;
        let undertone = (2.0 * PI * (frequency * 0.5) * time).sin() * 0.2;
        let pad = (2.0 * PI * 130.81 * time).sin() * 0.12;
        let shimmer = (2.0 * PI * 783.99 * time).sin() * 0.04;
        let sample = (lead * 0.42 + octave + undertone + pad + shimmer) * envelope * 0.58;
        let clamped = sample.clamp(-1.0, 1.0);
        samples.push((clamped * i16::MAX as f32) as i16);
    }

    samples
}

fn encode_wav(samples: &[i16]) -> Vec<u8> {
    let block_align = CHANNELS * (BITS_PER_SAMPLE / 8);
    let byte_rate = SAMPLE_RATE * block_align as u32;
    let data_size = std::mem::size_of_val(samples) as u32;
    let riff_size = 36 + data_size;

    let mut bytes = Vec::with_capacity((44 + data_size) as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&riff_size.to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&CHANNELS.to_le_bytes());
    bytes.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    bytes.extend_from_slice(&byte_rate.to_le_bytes());
    bytes.extend_from_slice(&block_align.to_le_bytes());
    bytes.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_size.to_le_bytes());

    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }

    bytes
}

#[cfg(test)]
mod tests {
    use super::{demo_duration_ms, ensure_demo_track, DEMO_TRACK_ID};
    use std::path::PathBuf;

    #[test]
    fn creates_demo_track_assets() {
        let root = tempfile::tempdir().expect("temp dir");
        let library_dir = root.path().join("library");
        let artwork_dir = root.path().join("artwork");
        std::fs::create_dir_all(&library_dir).expect("create library dir");
        std::fs::create_dir_all(&artwork_dir).expect("create artwork dir");

        let track = ensure_demo_track(&library_dir, &artwork_dir).expect("demo track");

        assert_eq!(track.id, DEMO_TRACK_ID);
        assert_eq!(track.source_kind, "demo");
        assert_eq!(track.duration_ms, demo_duration_ms());
        assert!(PathBuf::from(&track.file_path).exists());
        assert!(track.lyrics.as_ref().is_some_and(|lyrics| lyrics.is_synced));
        assert!(track
            .cover_art_path
            .as_ref()
            .is_some_and(|path| PathBuf::from(path).exists()));
    }
}
