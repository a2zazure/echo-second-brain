import os
import re
import shutil
import subprocess
import tempfile
import math
from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Callable

from faster_whisper import WhisperModel


@lru_cache(maxsize=1)
def get_whisper_model() -> WhisperModel:
    return WhisperModel(
        os.getenv("WHISPER_MODEL", "small"),
        device="cpu",
        compute_type="int8",
    )


ProgressCallback = Callable[[str], None]


def _audio_duration(path: str) -> float:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise RuntimeError("ffprobe is required for long-recording chunking. Install ffmpeg first.")
    result = subprocess.run(
        [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def _write_chunk(source: str, output: Path, start: float, duration: float) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required for long-recording chunking.")
    subprocess.run(
        [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
            "-ss", str(start), "-i", source, "-t", str(duration),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output),
        ],
        check=True,
        capture_output=True,
        text=True,
    )


def _normalise_word(word: str) -> str:
    return re.sub(r"[^\w']", "", word.casefold())


def _merge_with_overlap(previous: str, current: str) -> str:
    if not previous:
        return current.strip()
    previous_words = previous.split()
    current_words = current.split()
    max_overlap = min(80, len(previous_words), len(current_words))
    for size in range(max_overlap, 1, -1):
        left = [_normalise_word(word) for word in previous_words[-size:]]
        right = [_normalise_word(word) for word in current_words[:size]]
        if left == right:
            return " ".join(previous_words + current_words[size:]).strip()
    return f"{previous.strip()} {current.strip()}".strip()


def _transcribe_file(path: str, language: str | None = None) -> tuple[str, str]:
    segments, info = get_whisper_model().transcribe(
        path,
        language=language,
        vad_filter=True,
        condition_on_previous_text=True,
    )
    transcript = " ".join(segment.text.strip() for segment in segments).strip()
    return transcript, info.language or "unknown"


def transcribe_audio(path: str, progress: ProgressCallback | None = None) -> tuple[str, str]:
    chunk_seconds = max(60, int(float(os.getenv("AUDIO_CHUNK_MINUTES", "10")) * 60))
    overlap_seconds = max(0, int(os.getenv("AUDIO_CHUNK_OVERLAP_SECONDS", "3")))
    duration = _audio_duration(path)

    if duration <= chunk_seconds:
        if progress:
            progress("Transcribing audio with Whisper")
        return _transcribe_file(path)

    total_chunks = max(1, math.ceil(duration / chunk_seconds))
    if progress:
        progress(f"Preparing {total_chunks} audio chunks")

    transcript = ""
    languages: Counter[str] = Counter()
    detected_language: str | None = None
    source = str(Path(path).resolve())

    with tempfile.TemporaryDirectory(prefix="voice-notes-chunks-", dir=Path(path).parent) as temp_dir:
        temp_path = Path(temp_dir)
        for index in range(total_chunks):
            nominal_start = index * chunk_seconds
            nominal_end = min(duration, (index + 1) * chunk_seconds)
            start = max(0.0, nominal_start - (overlap_seconds if index else 0))
            end = min(duration, nominal_end + (overlap_seconds if index < total_chunks - 1 else 0))
            chunk_path = temp_path / f"chunk-{index + 1:04d}.wav"

            if progress:
                progress(f"Transcribing chunk {index + 1} of {total_chunks}")
            _write_chunk(source, chunk_path, start, end - start)
            chunk_text, language = _transcribe_file(str(chunk_path), detected_language)
            if language != "unknown":
                languages[language] += 1
                detected_language = detected_language or language
            transcript = _merge_with_overlap(transcript, chunk_text)
            chunk_path.unlink(missing_ok=True)

    language = languages.most_common(1)[0][0] if languages else "unknown"
    return transcript, language
