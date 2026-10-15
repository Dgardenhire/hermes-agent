"""Concurrent writers of ``context_length_cache.yaml`` (race audit lostupdate-7).

Every agent (CLI, gateway sessions, cron jobs, subagents) persists probed context windows with a
load -> mutate -> write cycle; an unserialized pair rewrites a stale snapshot and drops the other
writer's entry, so the next session re-probes or overflows its context on the first call.
"""

import threading

import pytest

import agent.model_metadata as mm


@pytest.mark.parametrize("first_writer", ["save", "invalidate"])
def test_concurrent_cache_writers_keep_each_others_entries(monkeypatch, first_writer):
    mm.save_context_length("model-a", "https://a.example/v1", 200_000)
    real_load = mm._load_context_cache_document
    loaded = threading.Event()
    other_saved = threading.Event()

    def parked_load():
        document = real_load()
        if threading.current_thread().name == "first-writer":
            loaded.set()
            # Unserialized writers let the other agent save here; serialized ones keep it out
            # until this cycle is written, so the wait is bounded.
            other_saved.wait(timeout=2)
        return document

    monkeypatch.setattr(mm, "_load_context_cache_document", parked_load)
    if first_writer == "save":
        action = lambda: mm.save_context_length("model-a", "https://a.example/v1", 128_000)
        expected_a = 128_000
    else:
        action = lambda: mm._invalidate_cached_context_length("model-a", "https://a.example/v1")
        expected_a = None
    worker = threading.Thread(target=action, name="first-writer")
    worker.start()
    assert loaded.wait(timeout=5)
    mm.save_context_length("model-b", "https://b.example/v1", 64_000)
    other_saved.set()
    worker.join(timeout=10)
    assert not worker.is_alive()

    assert mm.get_cached_context_length("model-b", "https://b.example/v1") == 64_000
    assert mm.get_cached_context_length("model-a", "https://a.example/v1") == expected_a
