"""Collect X research material separately from market candles and training labels.

Run from backend: python -m scripts.collect_gxt_x --help
Only the explicit `api` command makes authenticated (potentially billed) calls.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import html
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlparse
import uuid

import httpx


DEFAULT_OUTPUT = Path(__file__).resolve().parents[2] / "data/research/gxtradez"
API_BASE = "https://api.x.com/2"
MAX_IMAGE_BYTES = 25 * 1024 * 1024


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def username(value: str) -> str:
    value = value.lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9_]{1,15}", value):
        raise ValueError("Invalid X username")
    return value


def normalize(post: dict, handle: str, *, method: str, captured_at: str) -> dict:
    post_id = post.get("id")
    # IDs must stay strings: JavaScript numbers cannot preserve X's large IDs.
    if not isinstance(post_id, str) or not re.fullmatch(r"\d{1,25}", post_id):
        raise ValueError("Every post must have a decimal string ID")
    handle = username(handle)
    note = post.get("note_post") or post.get("note_tweet") or {}
    text = note.get("text") or post.get("text") or ""
    if not isinstance(text, str):
        raise ValueError("Post text must be a string")
    terms = {
        "psp": r"\bPSP\b|precision swing",
        "strength_switch": r"\bSS\b|strength switch",
        "universal_sequence": r"universal sequence",
        "four_hour": r"\b4\s*[hH]\b|\bH4\b",
        "smt": r"\bSMT\b",
        "po3": r"\bPO3\b|power of (?:3|three)",
    }
    return {
        "id": post_id,
        "username": handle,
        "source_url": f"https://x.com/{handle}/status/{post_id}",
        "text": text,
        "created_at": post.get("created_at"),
        "displayed_date": post.get("displayed_date"),
        "captured_at": captured_at,
        "capture_method": method,
        "conversation_id": post.get("conversation_id"),
        "referenced_posts": post.get("referenced_posts", post.get("referenced_tweets", [])),
        "entities": note.get("entities", post.get("entities", {})),
        "public_metrics": post.get("public_metrics", {}),
        "metrics_display": post.get("metrics_display", {}),
        "media": post.get("media", []),
        "keyword_hints": [key for key, pattern in terms.items() if re.search(pattern, text, re.I)],
        "promotion_hint": bool(re.search(r"discount|promo|payout|pays out|code:", text, re.I)),
        "review_status": "unreviewed",
        "training_eligible": False,
        "market_event_time": None,
        "retrospective": None,
        "usage_rights": "not_assessed",
    }


def upsert(output: Path, post: dict) -> None:
    path = output / "posts" / (post["id"] + ".json")
    if path.exists():
        old = json.loads(path.read_text(encoding="utf-8"))
        # Preserve curation and richer data when reimporting a public preview.
        for key in ("review_status", "training_eligible", "market_event_time", "retrospective", "usage_rights"):
            post[key] = old.get(key, post[key])
        for key in ("created_at", "conversation_id", "referenced_posts", "entities", "public_metrics"):
            if not post.get(key) and old.get(key):
                post[key] = old[key]
        if old.get("capture_method") == "x_api" and post["capture_method"] != "x_api":
            post["text"] = old["text"]
        old_media = {item.get("url"): item for item in old.get("media", [])}
        for item in post["media"]:
            previous = old_media.get(item.get("url"), {})
            for key in ("local_path", "sha256", "download_status", "download_error"):
                if key in previous:
                    item[key] = previous[key]
        if not post["media"]:
            post["media"] = old.get("media", [])
        post["first_captured_at"] = old.get("first_captured_at", old["captured_at"])
    write_json(path, post)


def import_browser(source: Path, output: Path) -> None:
    payload = json.loads(source.read_text(encoding="utf-8"))
    captured_at = payload.get("captured_at") or payload.get("capture_date") or now()
    posts = [normalize(post, post.get("username", "GxTradez"),
                       method=payload.get("capture_method", "browser_import"),
                       captured_at=captured_at) for post in payload["posts"]]
    raw = output / "raw" / f"browser-{uuid.uuid4().hex}.json"
    write_json(raw, payload)
    for post in posts:
        upsert(output, post)


def import_api_page(payload: dict, output: Path, handle: str, captured_at: str) -> None:
    media = {item["media_key"]: item for item in payload.get("includes", {}).get("media", [])}
    for original in payload.get("data", []):
        post = dict(original)
        post["media"] = [dict(media.get(key, {"media_key": key, "download_status": "unavailable"}))
                         for key in post.get("attachments", {}).get("media_keys", [])]
        upsert(output, normalize(post, handle, method="x_api", captured_at=captured_at))


def request_json(client: httpx.Client, path: str, params: dict | None = None) -> dict:
    response = client.get(API_BASE + path, params=params)
    if response.status_code == 429:
        reset = response.headers.get("x-rate-limit-reset", "unknown")
        raise RuntimeError(f"X rate limit reached (reset epoch: {reset}); progress is saved. Resume later.")
    if response.status_code in (401, 402, 403):
        raise RuntimeError(f"X returned HTTP {response.status_code}: check credentials, credits and endpoint access.")
    if response.is_error:
        # Do not print headers or request URLs containing credentials.
        raise RuntimeError(f"X returned HTTP {response.status_code}; progress is saved.")
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("Unexpected X response shape")
    return payload


def collect_api(output: Path, handle: str, max_pages: int, page_size: int, legacy_fields: bool) -> None:
    token = os.environ.get("X_BEARER_TOKEN", "").strip()
    if not token:
        raise ValueError("Set X_BEARER_TOKEN locally; do not paste it into chat or commit it.")
    state_path = output / "timeline-state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    config = {"username": handle, "legacy_fields": legacy_fields}
    if state and state.get("config") != config:
        raise ValueError("This output has another collection configuration; choose a new output directory.")
    if state.get("endpoint_exhausted"):
        print("Timeline endpoint already exhausted. This does not prove complete account history.")
        return
    with httpx.Client(headers={"Authorization": f"Bearer {token}"}, timeout=30,
                      follow_redirects=False) as client:
        user_id = state.get("user_id")
        if not user_id:
            payload = request_json(client, f"/users/by/username/{handle}")
            if not payload.get("data", {}).get("id"):
                raise RuntimeError("User lookup returned no account")
            user_id = payload["data"]["id"]
            write_json(output / "raw" / "account.json", payload)
        state.update({"config": config, "user_id": user_id})
        write_json(state_path, state)
        for _ in range(max_pages):
            # X's current docs use post.fields/note_post; the explicit switch
            # also supports deployments still using the older field names.
            field_key = "tweet.fields" if legacy_fields else "post.fields"
            note_key = "note_tweet" if legacy_fields else "note_post"
            params = {
                "max_results": page_size,
                field_key: f"created_at,conversation_id,attachments,entities,{note_key},public_metrics",
                "expansions": "attachments.media_keys",
                "media.fields": "media_key,type,url,preview_image_url,alt_text,width,height,variants",
                "exclude": "retweets",
            }
            if state.get("next_token"):
                params["pagination_token"] = state["next_token"]
            captured_at = now()
            payload = request_json(client, f"/users/{user_id}/tweets", params)
            write_json(output / "raw" / f"api-{uuid.uuid4().hex}.json", payload)
            if payload.get("errors"):
                raise RuntimeError("X returned partial errors; raw page saved, cursor not advanced. Inspect raw data.")
            import_api_page(payload, output, handle, captured_at)
            previous_token = state.get("next_token")
            next_token = payload.get("meta", {}).get("next_token")
            if next_token and next_token == previous_token:
                raise RuntimeError("X repeated a pagination token; stopping to avoid repeated billed reads.")
            state.update({"next_token": next_token, "updated_at": captured_at,
                          "endpoint_exhausted": not bool(next_token),
                          "pages_saved": state.get("pages_saved", 0) + 1})
            write_json(state_path, state)
            print(f"Saved page {state['pages_saved']} ({len(payload.get('data', []))} posts)")
            if not next_token:
                break


def download_media(output: Path, client: httpx.Client) -> dict:
    counts = {"downloaded": 0, "existing": 0, "failed": 0, "skipped": 0}
    for path in sorted((output / "posts").glob("*.json")):
        post = json.loads(path.read_text(encoding="utf-8"))
        for item in post.get("media", []):
            url = item.get("url")
            if item.get("type") != "photo" or not url:
                counts["skipped"] += 1
                continue
            parsed = urlparse(url)
            if parsed.scheme != "https" or parsed.hostname != "pbs.twimg.com" or parsed.username or parsed.password:
                item.update(download_status="failed", download_error="Untrusted media host")
                counts["failed"] += 1
                continue
            key = hashlib.sha256(url.encode()).hexdigest()
            extensions = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
            existing = next((output / "media" / (key + ext) for ext in (*extensions.values(), ".img")
                             if (output / "media" / (key + ext)).exists()), None)
            local = existing or output / "media" / (key + ".img")
            local.parent.mkdir(parents=True, exist_ok=True)
            if local.exists():
                item.update(local_path=str(local.relative_to(output)),
                            sha256=hashlib.sha256(local.read_bytes()).hexdigest(), download_status="downloaded")
                item.pop("download_error", None)
                counts["existing"] += 1
                continue
            temporary = local.with_suffix(".part")
            try:
                digest = hashlib.sha256()
                with client.stream("GET", url, follow_redirects=False) as response:
                    if response.status_code != 200:
                        raise ValueError(f"HTTP {response.status_code}")
                    content_type = response.headers.get("content-type", "").split(";")[0]
                    if content_type not in {"image/jpeg", "image/png", "image/webp", "image/gif"}:
                        raise ValueError("Response is not a supported raster image")
                    local = local.with_suffix(extensions[content_type])
                    size = 0
                    with temporary.open("wb") as stream:
                        for chunk in response.iter_bytes():
                            size += len(chunk)
                            if size > MAX_IMAGE_BYTES:
                                raise ValueError("Image exceeds 25 MiB")
                            digest.update(chunk)
                            stream.write(chunk)
                    if size == 0:
                        raise ValueError("Empty image")
                temporary.replace(local)
                item.update(local_path=str(local.relative_to(output)), sha256=digest.hexdigest(),
                            content_type=content_type, download_status="downloaded")
                item.pop("download_error", None)
                counts["downloaded"] += 1
            except (httpx.HTTPError, ValueError) as exc:
                temporary.unlink(missing_ok=True)
                item.update(download_status="failed", download_error=type(exc).__name__ + ": " + str(exc))
                counts["failed"] += 1
        write_json(path, post)
    return counts


def export(output: Path) -> dict:
    posts = [json.loads(path.read_text(encoding="utf-8")) for path in sorted((output / "posts").glob("*.json"))]
    output.mkdir(parents=True, exist_ok=True)
    with (output / "posts.jsonl.tmp").open("w", encoding="utf-8") as stream:
        for post in posts:
            stream.write(json.dumps(post, ensure_ascii=False) + "\n")
    (output / "posts.jsonl.tmp").replace(output / "posts.jsonl")
    count_media = sum(len(post["media"]) for post in posts)
    downloaded = sum(item.get("download_status") == "downloaded" for post in posts for item in post["media"])
    summary = {"posts": len(posts), "media_references": count_media, "media_downloaded": downloaded,
               "exact_post_times": sum(bool(post["created_at"]) for post in posts),
               "training_eligible": sum(post["training_eligible"] for post in posts),
               "generated_at": now(), "full_history_verified": False}
    write_json(output / "summary.json", summary)
    parts = ["<!doctype html><meta charset='utf-8'><title>GxTradez research collection</title>",
             "<style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:20px;background:#10151d;color:#eee}a{color:#8ac7ff}article{border-top:1px solid #456;padding:24px 0}pre{white-space:pre-wrap}img{max-width:100%;margin:8px 0}small{color:#abc}</style>",
             "<h1>GxTradez research collection</h1>",
             f"<p>{len(posts)} posts · {downloaded}/{count_media} attachments saved. Partial collection.</p>",
             "<p>Unreviewed source material. Post time is not trade time. Images may reveal future outcomes.</p>"]
    for post in posts:
        parts.append(f"<article><a href='{html.escape(post['source_url'], quote=True)}'>{post['id']}</a>"
                     f"<p>{html.escape(post.get('created_at') or post.get('displayed_date') or 'Time unknown')}</p>"
                     f"<pre>{html.escape(post['text'])}</pre>"
                     f"<small>Keyword hints: {html.escape(', '.join(post['keyword_hints'])) or 'none'} · "
                     f"Promotion hint: {post['promotion_hint']} · Review: {html.escape(post['review_status'])}</small>")
        for item in post["media"]:
            local_path = item.get("local_path", "")
            # Never allow untrusted input to inject remote/active resources.
            if re.fullmatch(r"media/[a-f0-9]{64}\.(?:img|jpg|png|webp|gif)", local_path):
                parts.append(f"<img loading='lazy' src='{local_path}' alt='Post attachment'>")
        parts.append("</article>")
    (output / "review.html").write_text("\n".join(parts), encoding="utf-8")
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    commands = parser.add_subparsers(dest="command", required=True)
    imp = commands.add_parser("import", help="Import a saved browser observation JSON; no network")
    imp.add_argument("source", type=Path)
    api = commands.add_parser("api", help="Fetch official X timeline; may consume paid API credits")
    api.add_argument("--username", type=username, default="GxTradez")
    api.add_argument("--max-pages", type=int, default=1)
    api.add_argument("--page-size", type=int, default=100)
    api.add_argument("--legacy-fields", action="store_true")
    commands.add_parser("media", help="Download previously collected photo URLs; no X credentials sent")
    commands.add_parser("export", help="Rebuild JSONL, summary, and local review gallery")
    args = parser.parse_args()
    output = args.output.resolve()
    try:
        failed_media = False
        if args.command == "import":
            import_browser(args.source, output)
        elif args.command == "api":
            if args.max_pages < 1 or not 5 <= args.page_size <= 100:
                raise ValueError("max-pages must be positive; page-size must be 5–100")
            collect_api(output, args.username, args.max_pages, args.page_size, args.legacy_fields)
        elif args.command == "media":
            with httpx.Client(timeout=30, follow_redirects=False) as client:
                counts = download_media(output, client)
                print(json.dumps(counts))
                failed_media = bool(counts["failed"])
        print(json.dumps(export(output), indent=2))
        return 1 if failed_media else 0
    except (ValueError, RuntimeError, httpx.HTTPError, OSError) as exc:
        print(f"Collection stopped: {exc}", file=sys.stderr)
        if (output / "posts").exists():
            export(output)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
