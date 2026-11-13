"""Collect public lesson captions and build a source-linked local research index.

No audio/video download, login bypass, trade labels, or training claims.
From backend: python -m scripts.collect_gxt_youtube collect|index|search
"""
from __future__ import annotations
import argparse
import hashlib
import json
from math import isfinite
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
CATALOG = Path(__file__).resolve().parents[1] / 'research/gxt_lessons.json'
OUTPUT = ROOT / 'data/research/gxtradez/youtube'


def lesson_chunks(lesson: dict, payload: dict) -> list[dict]:
    video = lesson['video_id']
    if payload.get('video_id') != video or not re.fullmatch(r'[\w-]{11}', video):
        raise ValueError('Caption source does not match the lesson ID')
    groups = {}
    previous = -1.0
    for segment in payload['segments']:
        start, duration = float(segment['start']), float(segment['duration'])
        if not isfinite(start) or not isfinite(duration) or start < previous or start < 0 or duration < 0:
            raise ValueError('Captions need finite, increasing timestamps and nonnegative durations')
        previous = start
        if not isinstance(segment['text'], str):
            raise ValueError('Caption text must be a string')
        groups.setdefault(int(start // 60), []).append(segment)
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return [dict(
        id=f'{video}:{minute}', video_id=video, title=lesson['title'], author=lesson['author'],
        start=parts[0]['start'], end=max(p['start']+p['duration'] for p in parts),
        source_url=f'https://www.youtube.com/watch?v={video}&t={int(parts[0]["start"])}',
        text=' '.join(p['text'] for p in parts), concepts=lesson['concepts'],
        source_sha256=digest, generated_captions=payload.get('generated', False),
        review_status='unreviewed', eligible_as_trade_label=False,
    ) for minute, parts in sorted(groups.items())]


def collect(lessons: list[dict], output: Path):
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError as exc:
        raise ValueError('Install optional requirements-research.txt to collect public captions') from exc
    import httpx
    output.mkdir(parents=True, exist_ok=True)
    api = YouTubeTranscriptApi()
    failures = []
    for lesson in lessons:
        video = lesson['video_id']
        try:
            metadata = httpx.get('https://www.youtube.com/oembed', params={
                'url': f'https://www.youtube.com/watch?v={video}', 'format': 'json',
            }, timeout=20)
            metadata.raise_for_status()
            meta = metadata.json()
            if meta.get('author_name') != lesson['author']:
                raise ValueError('Unexpected author: review source identity before importing')
            captions = api.fetch(video, languages=['en'])
            payload = dict(video_id=video, language=captions.language_code,
                           generated=captions.is_generated, segments=captions.to_raw_data())
            lesson_chunks(lesson, payload)  # validate before replacing a capture
            (output/f'{video}.json').write_text(json.dumps(payload, indent=2), encoding='utf-8')
            (output/f'{video}.metadata.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
            print(f'{video}: captured {len(payload["segments"])} caption segments')
        except Exception as exc:
            failures.append(video)
            print(f'{video}: unavailable ({type(exc).__name__}); no labels generated')
    if failures:
        raise ValueError('Some lessons could not be collected; existing captures were preserved')


def build_index(lessons: list[dict], output: Path):
    chunks, missing = [], []
    for lesson in lessons:
        path = output/f'{lesson["video_id"]}.json'
        if not path.exists():
            missing.append(lesson['video_id'])
            continue
        chunks.extend(lesson_chunks(lesson, json.loads(path.read_text(encoding='utf-8'))))
    if missing:
        raise ValueError('Missing captions; collect first: '+', '.join(missing))
    output.mkdir(parents=True, exist_ok=True)
    (output/'lessons.jsonl').write_text(''.join(json.dumps(c, ensure_ascii=False)+'\n' for c in chunks), encoding='utf-8')
    print(f'Indexed {len(chunks)} source-linked chunks; trade labels: 0; trained networks: 0')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['collect', 'index', 'search'])
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--query', default='')
    args = parser.parse_args()
    lessons = json.loads(CATALOG.read_text())['lessons']
    try:
        if args.command == 'collect':
            collect(lessons, args.output)
            build_index(lessons, args.output)
        elif args.command == 'index':
            build_index(lessons, args.output)
        else:
            terms = set(re.findall(r'\w+', args.query.lower()))
            if not terms:
                raise ValueError('Pass --query with the concept to look up')
            chunks = [json.loads(line) for line in (args.output/'lessons.jsonl').read_text().splitlines()]
            ranked = sorted(chunks, key=lambda c: -len(terms & set(re.findall(r'\w+', c['text'].lower()))))
            for chunk in ranked[:5]:
                print(f'{chunk["title"]}: {chunk["source_url"]}')
    except (ValueError, OSError) as exc:
        parser.exit(1, str(exc)+'\n')


if __name__ == '__main__':
    main()
