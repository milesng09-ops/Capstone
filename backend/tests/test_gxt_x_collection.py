import json

import httpx
import pytest

from scripts.collect_gxt_x import (
    collect_api, download_media, export, import_api_page, import_browser,
    normalize, request_json, upsert,
)


def make_post(**updates):
    return normalize({"id": "1234567890123456789", "text": "PSP at key level", **updates},
                     "GxTradez", method="browser_import", captured_at="2026-10-03")


def test_unknown_time_and_labels_are_not_fabricated():
    post = make_post(displayed_date="15h", text="Confirmed by SS")
    assert post["created_at"] is None
    assert post["market_event_time"] is None
    assert post["retrospective"] is None
    assert post["training_eligible"] is False
    assert post["keyword_hints"] == ["strength_switch"]


def test_ids_must_not_be_lossy_numbers():
    with pytest.raises(ValueError, match="string ID"):
        make_post(id=1234567890123456789)


def test_reimport_preserves_review_and_richer_data(tmp_path):
    first = make_post(created_at="2026-10-01T12:00:00Z")
    first.update(review_status="reviewed", retrospective=True, capture_method="x_api", text="Full long-form text")
    upsert(tmp_path, first)
    upsert(tmp_path, make_post())
    summary = export(tmp_path)
    assert summary["posts"] == 1
    post = json.loads((tmp_path / "posts.jsonl").read_text())
    assert post["retrospective"] is True
    assert post["created_at"] == "2026-10-01T12:00:00Z"
    assert post["text"] == "Full long-form text"


def test_long_posts_and_missing_media_are_retained(tmp_path):
    payload = {"data": [{"id": "1", "text": "short", "note_post": {"text": "Full PSP explanation"},
                         "attachments": {"media_keys": ["one", "missing"]}}],
               "includes": {"media": [{"media_key": "one", "type": "photo", "url": "https://pbs.twimg.com/media/one"}]}}
    import_api_page(payload, tmp_path, "GxTradez", "2026-10-03")
    post = json.loads((tmp_path / "posts/1.json").read_text())
    assert post["text"] == "Full PSP explanation"
    assert post["media"][1]["download_status"] == "unavailable"


def test_media_is_downloaded_without_credentials_and_reused(tmp_path):
    calls = []

    def handler(request):
        assert "authorization" not in request.headers
        calls.append(request)
        return httpx.Response(200, headers={"content-type": "image/png"}, content=b"test image bytes")

    upsert(tmp_path, make_post(media=[{"type": "photo", "url": "https://pbs.twimg.com/media/one"}]))
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert download_media(tmp_path, client)["downloaded"] == 1
        assert download_media(tmp_path, client)["existing"] == 1
    assert len(calls) == 1
    post = json.loads(next((tmp_path / "posts").glob("*.json")).read_text())
    assert post["media"][0]["local_path"].endswith(".png")
    assert len(post["media"][0]["sha256"]) == 64


def test_arbitrary_urls_and_redirects_not_followed(tmp_path):
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://127.0.0.1/private"})

    upsert(tmp_path, make_post(media=[
        {"type": "photo", "url": "http://127.0.0.1/private"},
        {"type": "photo", "url": "https://pbs.twimg.com/media/one"}]))
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert download_media(tmp_path, client)["failed"] == 2
    assert calls == ["https://pbs.twimg.com/media/one"]


def test_review_html_escapes_post_content(tmp_path):
    upsert(tmp_path, make_post(text="<script>alert(1)</script>"))
    export(tmp_path)
    assert "<script>" not in (tmp_path / "review.html").read_text()
    assert "&lt;script&gt;" in (tmp_path / "review.html").read_text()


def test_rate_limit_does_not_retry_or_expose_token():
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(429, headers={"x-rate-limit-reset": "123"}))) as client:
        with pytest.raises(RuntimeError, match="Resume later"):
            request_json(client, "/users/1/tweets")


def test_missing_token_stops_before_requests(tmp_path, monkeypatch):
    monkeypatch.delenv("X_BEARER_TOKEN", raising=False)
    with pytest.raises(ValueError, match="Set X_BEARER_TOKEN"):
        collect_api(tmp_path, "GxTradez", 1, 100, False)
    assert not (tmp_path / "timeline-state.json").exists()


def test_api_resumes_and_saves_last_page(tmp_path, monkeypatch):
    monkeypatch.setenv("X_BEARER_TOKEN", "fixture-only")
    requests = []

    def handler(request):
        requests.append(request)
        if request.url.path.endswith("/by/username/GxTradez"):
            return httpx.Response(200, json={"data": {"id": "42"}})
        if request.url.params.get("pagination_token") == "next":
            return httpx.Response(200, json={"data": [{"id": "2", "text": "second"}], "meta": {}})
        return httpx.Response(200, json={"data": [{"id": "3", "text": "first"}], "meta": {"next_token": "next"}})

    original_client = httpx.Client
    monkeypatch.setattr("scripts.collect_gxt_x.httpx.Client", lambda **kw: original_client(transport=httpx.MockTransport(handler), **kw))
    collect_api(tmp_path, "GxTradez", 1, 100, False)
    assert json.loads((tmp_path / "timeline-state.json").read_text())["next_token"] == "next"
    collect_api(tmp_path, "GxTradez", 1, 100, False)
    state = json.loads((tmp_path / "timeline-state.json").read_text())
    assert state["endpoint_exhausted"] is True
    assert state["pages_saved"] == 2
    assert len(requests) == 3
    assert export(tmp_path)["posts"] == 2


def test_browser_import_preserves_raw_observation(tmp_path):
    source = tmp_path / "source.json"
    payload = {"capture_date": "2026-10-03", "posts": [{"id": "1", "text": "PSP"}]}
    source.write_text(json.dumps(payload))
    import_browser(source, tmp_path / "result")
    raw = next((tmp_path / "result/raw").glob("*.json"))
    assert json.loads(raw.read_text()) == payload
