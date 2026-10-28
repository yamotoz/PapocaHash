import hashlib
import json
import os
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import dataset
from backend.crypto import hashes, parse_target, preview_hash, verifier
from backend.kernels import iterative, recursive
from backend.python_engine import PythonEngine
from backend.preview import CandidatePreview
from backend.rust_engine import EXECUTABLE, run as rust_run
from backend.server import app
from backend import server

ENGINES = ("python-iterative", "python-recursive", "rust")
ALGORITHMS = ("md5", "sha512", "bcrypt", "argon2id")


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_preview_hash_uses_target_parameters(algorithm):
    target = hashes("ação🔷")[algorithm]
    assert preview_hash(algorithm, target, "ação🔷") == target
    assert preview_hash(algorithm, target, "outro candidato") != target


@pytest.mark.parametrize("engine", ENGINES)
def test_candidate_samples_are_real_and_bounded(engine):
    snapshot = dataset.prepare("ação🔷", 9, 37)
    target = hashes("absent")["md5"]
    samples = []
    preview = CandidatePreview(snapshot)
    def on_candidates(positions):
        samples.extend(preview.read(positions))
    try:
        if engine == "rust":
            result = rust_run(snapshot, "md5", target, 1, 8, lambda *args: None, lambda: False, on_candidates=on_candidates)
        else:
            pool = PythonEngine(1)
            try:
                result = pool.run(snapshot, "md5", target, engine, 8, lambda *args: None, lambda: False, on_candidates=on_candidates)
            finally:
                pool.close()
        words = Path(snapshot["text"]).read_text(encoding="utf-8").splitlines()
        assert result["attempts"] == 37
        assert samples and samples[-1]["position"] == 37
        assert all(sample["word"] == words[sample["position"] - 1] and sample["worker"] == 1 for sample in samples)
        assert preview.read([0, -1, 38, 9])[0]["word"] == "ação🔷"
        assert len(preview.read([9] * 256)) == 16
    finally:
        preview.close()


def test_api_jobs_deliver_samples_for_all_engines(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ROOT", tmp_path)
    with TestClient(app) as client:
        snapshot = dataset.prepare("ação🔷", 31, 37)
        app.state.lab.experiments[snapshot["id"]] = {"dataset": snapshot}
        target = hashes("ação🔷")["md5"]
        words = Path(snapshot["text"]).read_text(encoding="utf-8").splitlines()
        for engine in ENGINES:
            response = client.post("/api/jobs", json={"experiment_id": snapshot["id"], "algorithm": "md5", "engine": engine, "target": target, "workers": 1})
            assert response.status_code == 200
            job_id, deadline = response.json()["id"], time.monotonic() + 10
            while True:
                result = client.get(f"/api/jobs/{job_id}").json()
                if result["status"] in ("found", "error") or time.monotonic() >= deadline:
                    break
                time.sleep(.02)
            assert result["status"] == "found"
            assert result["word"] == "ação🔷"
            assert result["preview_candidates"]
            sequences = [sample["seq"] for sample in result["preview_candidates"]]
            assert 1 <= len(sequences) <= 96
            assert sequences == sorted(set(sequences))
            assert all(sample["word"] == words[sample["position"] - 1] and
                       sample["hash"] == hashlib.md5(sample["word"].encode(), usedforsecurity=False).hexdigest()
                       for sample in result["preview_candidates"])


def test_api_keeps_recent_candidate_history_in_order(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "ROOT", tmp_path)
    fake_binary = tmp_path / "fake-rust.exe"
    fake_binary.touch()
    monkeypatch.setattr(server.rust_engine, "EXECUTABLE", fake_binary)

    def fake_run(*args):
        on_candidates = args[-1]
        for position in range(1, 141):
            on_candidates([position])
        return {"status": "exhausted", "attempts": 140, "elapsed": .1}

    monkeypatch.setattr(server.rust_engine, "run", fake_run)
    with TestClient(app) as client:
        snapshot = dataset.prepare("seed", 150, 150)
        app.state.lab.experiments[snapshot["id"]] = {"dataset": snapshot}
        target = hashes("absent")["md5"]
        response = client.post("/api/jobs", json={"experiment_id": snapshot["id"], "algorithm": "md5", "engine": "rust", "target": target, "workers": 1})
        assert response.status_code == 200
        job_id, deadline = response.json()["id"], time.monotonic() + 10
        while True:
            result = client.get(f"/api/jobs/{job_id}").json()
            if result["status"] in ("exhausted", "error") or time.monotonic() >= deadline:
                break
            time.sleep(.02)
        assert result["status"] == "exhausted"
        samples = result["preview_candidates"]
        assert len(samples) == 96
        assert [sample["seq"] for sample in samples] == list(range(45, 141))
        assert [sample["position"] for sample in samples] == list(range(45, 141))
        assert all(sample["hash"] == hashlib.md5(sample["word"].encode(), usedforsecurity=False).hexdigest() for sample in samples)


@pytest.fixture(autouse=True)
def isolated_data(tmp_path, monkeypatch):
    monkeypatch.setattr(dataset, "DATA", tmp_path)


@pytest.fixture(scope="module")
def python_pool():
    pool = PythonEngine(min(os.cpu_count() or 1, 4))
    yield pool
    pool.close()


@pytest.mark.parametrize("kernel", (iterative, recursive))
@pytest.mark.parametrize("position", (0, 1, 511, 4095))
def test_kernels_visit_once(kernel, position):
    words = [str(i).encode() for i in range(4096)]
    visited = []
    def check(word):
        visited.append(word)
        return word == words[position]
    assert kernel(words, check) == position
    assert visited == words[:position + 1]


def test_recursive_exhausts_million():
    words = [b"candidate"] * 1_000_000
    calls = 0
    def check(_):
        nonlocal calls
        calls += 1
        return False
    assert recursive(words, check) is None
    assert calls == 1_000_000


@pytest.mark.parametrize("word", ("fronteira", "ação🔷", "a" * 72, "papoca0000003"))
def test_unique_snapshot(word):
    snapshot = dataset.prepare(word, position=20, size=30)
    words = Path(snapshot["text"]).read_bytes().splitlines()
    assert len(words) == len(set(words)) == 30
    assert words[19].decode() == word
    raw = Path(snapshot["index"]).read_bytes()
    offsets = memoryview(raw).cast("Q")
    assert offsets[-1] == Path(snapshot["text"]).stat().st_size
    text = Path(snapshot["text"]).read_bytes()
    for i, entry in enumerate(words):
        assert text[offsets[i]:offsets[i + 1]] == entry + b"\n"


def test_worker_error_propagates_and_pool_recovers(python_pool):
    snapshot = dataset.prepare("valid", 1, 10)
    snapshot["text"] = str(Path(snapshot["text"]).parent / "missing.txt")
    with pytest.raises(FileNotFoundError):
        python_pool.run(snapshot, "md5", hashes("valid")["md5"], "python-iterative", 16, lambda *args: None, lambda: False)
    good = dataset.prepare("valid", 1, 10)
    result = python_pool.run(good, "md5", hashes("valid")["md5"], "python-iterative", 16, lambda *args: None, lambda: False)
    assert result["status"] == "found"


@pytest.mark.parametrize("word", ("", "é" * 37, "abc\nxyz", "abc\rxyz", "abc\x00xyz"))
def test_invalid_words(word):
    with pytest.raises(ValueError):
        dataset.prepare(word, 1, 5)


def test_known_md5_sha512_and_unicode():
    result = hashes("abc")
    assert result["md5"] == "900150983cd24fb0d6963f7d28e17f72"
    assert result["sha512"] == hashlib.sha512(b"abc").hexdigest()
    for algorithm, target in hashes("ação🔷").items():
        assert verifier(algorithm, target)("ação🔷".encode())
        assert not verifier(algorithm, target)(b"wrong")


@pytest.mark.parametrize("algorithm,target", (("md5", "g" * 32), ("md5", " " * 32), ("sha512", "a" * 127), ("bcrypt", "$2b$12$wrong"), ("argon2id", "$argon2id$v=19$m=65536,t=3,p=4$x$x")))
def test_bad_targets(algorithm, target):
    with pytest.raises(ValueError):
        parse_target(algorithm, target)


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("algorithm", ALGORITHMS)
@pytest.mark.parametrize("position", (1, 97))
def test_all_engines_and_cross_language(engine, algorithm, position, python_pool):
    if engine == "rust" and not EXECUTABLE.exists():
        pytest.fail("Motor Rust não compilado: execute server.bat antes dos testes.")
    snapshot = dataset.prepare("ação🔷", position, 97)
    target = hashes("ação🔷")[algorithm]
    updates = []
    update = lambda attempts, elapsed, pids: updates.append((attempts, elapsed))
    if engine == "rust":
        result = rust_run(snapshot, algorithm, target, python_pool.workers, 16, update, lambda: False)
    else:
        result = python_pool.run(snapshot, algorithm, target, engine, 16, update, lambda: False)
    assert result["status"] == "found"
    assert result["word"] == "ação🔷"
    assert result["position"] == position
    assert 1 <= result["attempts"] <= snapshot["count"]
    assert all(a <= b for (a, _), (b, _) in zip(updates, updates[1:]))


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_absence(engine, algorithm, python_pool):
    snapshot = dataset.prepare("inserida", 50, 97)
    target = hashes("ausente")[algorithm]
    update = lambda *args: None
    if engine == "rust":
        result = rust_run(snapshot, algorithm, target, 2, 16, update, lambda: False)
    else:
        result = python_pool.run(snapshot, algorithm, target, engine, 16, update, lambda: False)
    assert result["status"] == "exhausted"
    assert result["attempts"] == 97


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("kind", ("cancel", "timeout"))
def test_interruptions(engine, kind, python_pool):
    snapshot = dataset.prepare("inserida", 900, 1000)
    target = hashes("ausente")["argon2id"]
    cancel = threading.Event()
    def update(*_):
        if kind == "cancel":
            cancel.set()
    timeout = .02 if kind == "timeout" else None
    if engine == "rust":
        result = rust_run(snapshot, "argon2id", target, 2, 64, update, cancel.is_set, timeout)
    else:
        result = python_pool.run(snapshot, "argon2id", target, engine, 64, update, cancel.is_set, timeout)
    assert result["status"] == ("timeout" if kind == "timeout" else "cancelled")
    assert result["attempts"] < 1000
    assert result["stop_latency"] is not None


def test_api_health_cors_and_validation():
    with TestClient(app) as client:
        response = client.get("/api/health", headers={"Origin": "null"})
        assert response.json()["service"] == "PapocaHash"
        assert response.headers["access-control-allow-origin"] == "*"
        assert client.post("/api/experiments", json={"word": "é" * 37}).status_code == 422
        assert client.post("/api/jobs", json={"experiment_id": "missing", "algorithm": "md5", "engine": "rust", "target": "a" * 32, "workers": 1}).status_code == 404
        assert client.get("/api/jobs/missing").status_code == 404
        assert client.get("/assets/../../pyproject.toml").status_code == 404


@pytest.mark.full
@pytest.mark.parametrize("word,position", (("ação🔷", 500_000), ("papoca0000003", 750_000), ("a" * 72, 1_000_000)))
def test_full_snapshot_index_and_uniqueness(word, position):
    snapshot = dataset.prepare(word, position)
    words = Path(snapshot["text"]).read_bytes().splitlines()
    offsets = memoryview(Path(snapshot["index"]).read_bytes()).cast("Q")
    assert len(words) == len(set(words)) == 1_000_000
    assert words[position - 1] == word.encode()
    text = Path(snapshot["text"]).read_bytes()
    for i in (0, 3, 499_999, position - 1, 999_999):
        assert text[offsets[i]:offsets[i+1]] == words[i] + b"\n"


@pytest.mark.full
@pytest.mark.parametrize("algorithm", ALGORITHMS)
@pytest.mark.parametrize("engine", ENGINES)
def test_full_million(engine, algorithm):
    snapshot = dataset.prepare("Papoca-fronteira-1kk", 1_000_000)
    target = hashes("Papoca-fronteira-1kk")[algorithm]
    workers = os.cpu_count() or 1
    block = 4096 if algorithm in ("md5", "sha512") else 64
    update = lambda *args: None
    if engine == "rust":
        result = rust_run(snapshot, algorithm, target, workers, block, update, lambda: False)
    else:
        pool = PythonEngine(workers)
        try:
            result = pool.run(snapshot, algorithm, target, engine, block, update, lambda: False)
        finally:
            pool.close()
    assert result["status"] == "found"
    assert result["position"] == 1_000_000
    assert 1_000_000 - workers * block <= result["attempts"] <= 1_000_000
