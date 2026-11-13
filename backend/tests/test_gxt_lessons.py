import pytest
from scripts.collect_gxt_youtube import lesson_chunks


def test_caption_index_retains_citations_and_cannot_be_used_as_trade_truth():
    lesson = dict(video_id='BueHY7EFUx0', title='Lesson', author='Garrett', concepts=['continuation'])
    payload = dict(video_id=lesson['video_id'], generated=True, segments=[
        dict(start=59, duration=2, text='first'), dict(start=61, duration=1, text='second')])
    chunks = lesson_chunks(lesson, payload)
    assert len(chunks) == 2
    assert chunks[0]['source_url'].endswith('&t=59')
    assert chunks[1]['start'] == 61
    assert all(not c['eligible_as_trade_label'] and c['review_status']=='unreviewed' for c in chunks)
    payload['segments'][1]['start'] = -1
    with pytest.raises(ValueError, match='timestamps'):
        lesson_chunks(lesson, payload)


def test_saved_run_labels_distinguish_new_sequence_from_legacy():
    from app.backtesting.attempts import describe_configuration
    assert 'v2' in describe_configuration(dict(strategy='gxt_research', gxt=dict(sequence_model='c2_continuation')))
    assert 'v1' in describe_configuration(dict(strategy='gxt_research'))
