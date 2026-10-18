# GxTradez X research collection

The standalone collector saves public source material under
`data/research/gxtradez/` (gitignored). It does not insert social posts into the
market candle database or automatically assign verified GxT training labels.

## Files

- `raw/`: original imported observations and API pages.
- `posts/`: one normalized JSON record per post ID; repeated imports update it.
- `posts.jsonl`: consolidated records for downstream annotation.
- `media/`: downloaded photo attachments, identified by URL hash, with content
  SHA-256 recorded in each post.
- `review.html`: local gallery for reviewing text and images together.
- `summary.json`: actual counts and explicit incomplete-history status.
- `timeline-state.json`: official API pagination checkpoint, if that route is used.

The initial 2026-10-03 logged-out profile exposed five posts, including a pinned
promotion, with 16 photo references. The profile displayed 4,408 total posts.
That displayed count includes material not necessarily available through the
same endpoint/filter; it is not a completeness target. The preview only showed
relative/short dates, so exact `created_at` values are null.

## Commands

Run from `backend` using its virtualenv:

```sh
.venv/bin/python -m scripts.collect_gxt_x import ../data/research/gxtradez/public-preview.json
.venv/bin/python -m scripts.collect_gxt_x media
.venv/bin/python -m scripts.collect_gxt_x export
```

The import accepts a JSON object containing `posts` and optional `capture_date`,
`captured_at`, `capture_method`, and coverage notes. Posts need decimal string
`id`, `username`, `text`, optional `created_at`/`displayed_date`, and `media`
objects with `type: "photo"` and the observed `url`. Preserve raw observations.
Do not fabricate exact timestamps from relative labels or invent absent threads.

## Official API route (optional, potentially billed)

Set `X_BEARER_TOKEN` in the invoking process using your local secret-management
workflow. The script deliberately does not print tokens or read browser cookies.
It does not automatically read `.env` files. No paid request was made during
initial collection. Check your X developer account's credits and spending limits
before running this command:

```sh
.venv/bin/python -m scripts.collect_gxt_x api --max-pages 1 --page-size 100
```

Default is one page. Run again to resume older posts; use an explicit larger
page limit for a longer bounded run. Replies are included, reposts excluded.
Photo URLs are expanded. Video metadata/variants are retained when available;
the `media` command downloads photos only. Quote/reply references are preserved
when present; referenced posts and full conversations are not recursively fetched.
API includes can contain missing media or partial errors; raw pages are saved
and partial-error pages stop without advancing the cursor. Rate limits stop
with a saved checkpoint instead of waiting indefinitely or retrying billed calls.

Current X documentation uses `post.fields` and `note_post`. If your API deployment
requires older field names, use `--legacy-fields` in a **new output directory**:

```sh
.venv/bin/python -m scripts.collect_gxt_x --output ../data/research/gxtradez-legacy api --legacy-fields
```

Live API behavior remains unverified until credentials are provided; the
pagination/import paths are tested against simulated HTTP responses.

This collector implements the user-timeline endpoint, which has a bounded
history. Exhausting its pagination does not mean every historical post was
retrieved. Older content needs authorized full-archive search access or a
creator-provided export. There is no login/CAPTCHA bypass or private-account
collection. For new posts after completing a timeline run, choose a new output
directory; this version resumes backward pagination, not an incremental monitor.
Do not run concurrent writers against the same output directory.

References checked 2026-10-03:
- https://docs.x.com/x-api/users/get-posts
- https://docs.x.com/x-api/posts/timelines/introduction
- https://docs.x.com/x-api/posts/search/introduction
- https://docs.x.com/x-api/getting-started/pricing

## Before using these records in training

Every new record is `unreviewed`, `training_eligible: false`, with unknown
`market_event_time`, `retrospective`, and unassessed usage rights. `keyword_hints`
and `promotion_hint` are simple text searches, not GxT annotations or reliable
trade classifications. Keep manual labels in a separate versioned annotation
dataset; the collector preserves its existing curation fields on reimport.

Record chart symbol/contract, timeframe, session timezone, trade time, and the
latest visible candle manually or with reviewed OCR. Post time is publication
time, not entry time. A screenshot may already expose the trade's outcome.
Group related posts and near-duplicate charts in the same training/evaluation
partition. Selected trade posts are not a representative performance history;
add independent market episodes and failed/no-setup examples for evaluation.
Confirm applicable creator/platform permissions before using source content for
model training or redistributing it. Collection itself does not establish rights.
