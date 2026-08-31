#!/usr/bin/env python3
"""
yt_transcript.py - Pull and clean a YouTube transcript as markdown.

Built for the save-to-reading skill (mooch.agency). Public-safe and relocatable:
no hardcoded paths, no credentials. Run it from anywhere.

Usage:
    python3 yt_transcript.py <url_or_id> [output.md]

If output.md is omitted, prints to stdout.

Caption path (fast, default):
    pip install youtube-transcript-api
    Pulls auto-captions or uploaded subtitles via the YouTube transcript API.

Whisper fallback (when captions are disabled):
    The transcript API raises when a video has no captions. In that case,
    download the audio and transcribe locally. This script does not bundle
    whisper to keep the dependency surface small; run the fallback by hand:

        yt-dlp -x --audio-format mp3 -o audio.mp3 "<url>"
        whisper audio.mp3 --model small --output_format txt

    then feed the resulting text through the skill's clean/format steps.
    (yt-dlp: https://github.com/yt-dlp/yt-dlp ; whisper: pip install openai-whisper)

Output: cleaned markdown with filler words stripped, doubled words collapsed,
and `>>` speaker markers preserved as paragraph breaks. Title and channel are
auto-fetched via YouTube oEmbed.
"""

import re
import sys
import json
import urllib.request


def extract_video_id(url_or_id):
    if len(url_or_id) == 11 and re.match(r'^[\w-]+$', url_or_id):
        return url_or_id
    m = re.search(r'(?:v=|/v/|youtu\.be/|/embed/|/shorts/|/live/)([\w-]{11})', url_or_id)
    if m:
        return m.group(1)
    raise ValueError(f'Could not extract video ID from: {url_or_id}')


def get_video_meta(video_id):
    try:
        url = f'https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json'
        with urllib.request.urlopen(url, timeout=10) as r:
            data = json.loads(r.read())
            return data.get('title'), data.get('author_name')
    except Exception:
        return None, None


def fetch_transcript(video_id):
    # Raises if captions are disabled. The skill then falls back to whisper
    # (see the module docstring) rather than scraping another way.
    from youtube_transcript_api import YouTubeTranscriptApi
    ytt = YouTubeTranscriptApi()
    return ytt.fetch(video_id)


def clean_text(text):
    # Strip common filler words.
    fillers = [' uh ', ' um ', ' you know, ', ' kind of ', ' sort of ', ' I mean, ', ' like, ']
    for f in fillers:
        text = re.sub(re.escape(f), ' ', text, flags=re.IGNORECASE)
    # Collapse doubled words (e.g. "the the" -> "the").
    text = re.sub(r'\b(\w+) \1\b', r'\1', text, flags=re.IGNORECASE)
    # Normalise whitespace and orphan punctuation.
    text = re.sub(r'\s+', ' ', text)
    text = re.sub(r' ([,.!?])', r'\1', text)
    return text.strip()


def build_markdown(video_id, transcript, title=None, channel=None):
    text = ' '.join(entry.text.strip() for entry in transcript)
    text = clean_text(text)
    parts = [p.strip() for p in re.split(r'\s*>>\s*', text) if p.strip()]

    out = []
    if title:
        # Colon, not a dash: house style bans em dashes everywhere, headers included.
        header = f'# {title}'
        if channel:
            header += f': {channel}'
        out.append(header)
    out.append(f'Source: https://www.youtube.com/watch?v={video_id}')
    out.append('')
    out.append('---')
    out.append('')
    for p in parts:
        out.append(p)
        out.append('')
    return '\n'.join(out)


def main():
    if len(sys.argv) < 2:
        print('Usage: yt_transcript.py <url_or_id> [output.md]', file=sys.stderr)
        sys.exit(1)

    url_or_id = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None

    video_id = extract_video_id(url_or_id)
    title, channel = get_video_meta(video_id)
    transcript = fetch_transcript(video_id)
    md = build_markdown(video_id, transcript, title=title, channel=channel)

    if output_path:
        with open(output_path, 'w') as f:
            f.write(md)
        print(f'Saved {len(md)} chars to {output_path}', file=sys.stderr)
    else:
        print(md)


if __name__ == '__main__':
    main()
