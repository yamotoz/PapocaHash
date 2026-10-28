"""API local: a fila serial mantém as comparações livres de competição."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
import json
import threading
import time
import uuid

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
import uvicorn

from .catalog import catalog
from .crypto import ALGORITHMS, hashes, parse_target, preview_hash
from .dataset import ROOT, ensure_base, prepare
from .metrics import GPU, Resources
from .python_engine import PythonEngine
from .preview import CandidatePreview
from . import rust_engine
from . import gpu_engine


@dataclass
class Job:
    payload: dict
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    state: dict = field(default_factory=dict)
    samples: list = field(default_factory=lambda: [{"attempts": 0, "elapsed": 0, "cpu": 0, "memory_mb": 0}])
    cancel: threading.Event = field(default_factory=threading.Event)
    cancel_requested_at: float | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)

    def snapshot(self):
        with self.lock:
            return {"id": self.id, **self.payload, **self.state, "samples": self.samples.copy()}


class Laboratory:
    def __init__(self):
        self.id = uuid.uuid4().hex
        self.experiments, self.jobs, self.pools = {}, {}, {}
        self.executor = ThreadPoolExecutor(1, thread_name_prefix="papoca-jobs")
        self.gpu = GPU()
        self.gpu_backend = gpu_engine.Backend()

    def execute(self, job):
        dataset = self.experiments[job.payload["experiment_id"]]["dataset"]
        resources, wall_start = Resources(), time.perf_counter()
        with job.lock:
            if job.cancel.is_set():
                job.state["status"] = "cancelled"
                return
            job.state["status"] = "preparing"
        def update(attempts, elapsed, pids):
            sample = {"attempts": attempts, "elapsed": elapsed, **resources.sample(pids)}
            with job.lock:
                job.state.update({"status": "running", **sample})
                job.samples.append(sample)
                # Limite de armazenamento, preservando amostras do início ao fim.
                if len(job.samples) > 2400:
                    job.samples = job.samples[::2]
        preview = None
        try:
            preview = CandidatePreview(dataset)
            algorithm, target, engine = (job.payload[key] for key in ("algorithm", "target", "engine"))
            preview_offset = 0
            hash_cache = {}
            preview_samples = []
            preview_seq = 0
            last_positions = {}
            def on_candidates(positions):
                nonlocal preview_offset, hash_cache, preview_samples, preview_seq
                candidates = preview.read(positions)
                if algorithm in ("bcrypt", "argon2id") and len(candidates) > 4:
                    count = len(candidates)
                    candidates = [candidates[(preview_offset + index) % count] for index in range(4)]
                    preview_offset = (preview_offset + 4) % count
                fresh = []
                for candidate in candidates:
                    position = candidate["position"]
                    worker = candidate["worker"]
                    if last_positions.get(worker) == position:
                        continue
                    last_positions[worker] = position
                    candidate["hash"] = hash_cache.get(position) or preview_hash(algorithm, target, candidate["word"])
                    hash_cache[position] = candidate["hash"]
                    preview_seq += 1
                    candidate["seq"] = preview_seq
                    fresh.append(candidate)
                if len(hash_cache) > 128:
                    hash_cache = {candidate["position"]: candidate["hash"] for candidate in fresh}
                if not fresh:
                    return
                preview_samples = (preview_samples + fresh)[-96:]
                with job.lock:
                    job.state["preview_candidates"] = preview_samples
            workers, block = job.payload["workers"], job.payload["block_size"]
            timeout = job.payload["timeout"]
            if engine == "gpu-hashcat":
                result = gpu_engine.run(dataset, algorithm, target, job.payload["gpu_device_id"], update, job.cancel.is_set, timeout)
            elif engine == "rust":
                result = rust_engine.run(dataset, algorithm, target, workers, block, update, job.cancel.is_set, timeout, on_candidates)
            else:
                if workers not in self.pools:
                    for old_pool in self.pools.values():
                        old_pool.close()
                    self.pools.clear()
                    self.pools[workers] = PythonEngine(workers)
                result = self.pools[workers].run(dataset, algorithm, target, engine, block, update, job.cancel.is_set, timeout, on_candidates)
            elapsed = result["elapsed"]
            if result["status"] == "cancelled" and job.cancel_requested_at is not None:
                result["stop_latency"] = time.perf_counter() - job.cancel_requested_at
            with job.lock:
                job.samples = [sample for sample in job.samples if sample["elapsed"] <= elapsed]
                job.samples.append({"attempts": result["attempts"], "elapsed": elapsed, "cpu": job.state.get("cpu", 0), "memory_mb": job.state.get("memory_mb", 0)})
                job.state.update({**result, "total_seconds": time.perf_counter() - wall_start,
                                  "rate": result["attempts"] / elapsed if elapsed else 0,
                                  **resources.summary(result.get("cpu_seconds"), elapsed)})
            report_dir = ROOT / "data" / "results"
            report_dir.mkdir(parents=True, exist_ok=True)
            (report_dir / f"{job.id}.json").write_text(json.dumps(job.snapshot(), ensure_ascii=False), encoding="utf-8")
        except Exception as error:
            with job.lock:
                job.state.update(status="error", error=str(error))
            for workers, pool in list(self.pools.items()):
                if pool.broken or pool.pool._broken:
                    pool.close()
                    del self.pools[workers]
        finally:
            if preview:
                preview.close()

    def close(self):
        for job in self.jobs.values():
            job.cancel.set()
        self.executor.shutdown(wait=True, cancel_futures=True)
        for pool in self.pools.values():
            pool.close()
        self.gpu.stop.set()
        self.gpu_backend.stop.set()


@asynccontextmanager
async def lifespan(app):
    ensure_base()
    app.state.lab = Laboratory()
    yield
    app.state.lab.close()


app = FastAPI(title="PapocaHash", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False,
                   allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type"])


class ExperimentInput(BaseModel):
    word: str = Field(min_length=1, max_length=72)


class JobInput(BaseModel):
    experiment_id: str
    algorithm: str
    target: str = Field(max_length=256)
    engine: str
    device: str = "cpu"
    gpu_device_id: int | None = Field(default=None, ge=1)
    workers: int = Field(ge=1, le=256)
    timeout: float | None = Field(default=None, gt=0, le=604800)
    block_size: int | None = Field(default=None, ge=1, le=65536)


@app.get("/api/health")
def health():
    return {"status": "online", "service": "PapocaHash", "instance_id": app.state.lab.id, "version": "1.0.0", **catalog(), "gpu": {**app.state.lab.gpu.value, "accelerates_search": app.state.lab.gpu_backend.value["available"]}, "gpu_engine": app.state.lab.gpu_backend.value}


@app.get("/api/catalog")
def engines():
    return catalog()


@app.post("/api/experiments")
def experiment(body: ExperimentInput):
    try:
        targets = hashes(body.word) if 0 < len(body.word.encode("utf-8")) <= 72 else None
        if targets is None:
            raise ValueError("O limite é de 72 bytes UTF-8.")
        dataset = prepare(body.word)
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    result = {"id": dataset["id"], "dataset": dataset, "targets": targets}
    app.state.lab.experiments[result["id"]] = result
    return {"id": result["id"], "count": dataset["count"], "position": dataset["position"], "targets": targets,
            "parameters": {"bcrypt_cost": 4, "argon2id": {"memory_kib": 8192, "iterations": 2, "lanes": 1}, "profile": "didactic"}}


@app.post("/api/jobs")
def create_job(body: JobInput):
    lab = app.state.lab
    if body.experiment_id not in lab.experiments:
        raise HTTPException(404, "Experimento não encontrado. Prepare a palavra novamente.")
    if body.algorithm not in ALGORITHMS or body.engine not in ("python-iterative", "python-recursive", "rust", "gpu-hashcat"):
        raise HTTPException(422, "Algoritmo ou motor desconhecido.")
    if body.device not in ("cpu", "gpu") or (body.engine == "gpu-hashcat") != (body.device == "gpu"):
        raise HTTPException(422, "Escolha um motor compatível com o dispositivo.")
    if body.device == "gpu":
        capability = lab.gpu_backend.value
        if not capability["available"]:
            raise HTTPException(503, capability["reason"])
        device_ids = [device["id"] for device in capability["devices"]]
        if body.gpu_device_id is not None and body.gpu_device_id not in device_ids:
            raise HTTPException(422, "GPU não encontrada entre os dispositivos disponíveis.")
    elif body.gpu_device_id is not None:
        raise HTTPException(422, "GPU só pode ser selecionada para execuções na GPU.")
    if body.workers > catalog()["workers"]:
        raise HTTPException(422, "Número de trabalhadores maior que os processadores disponíveis.")
    if body.engine == "rust" and not rust_engine.EXECUTABLE.exists():
        raise HTTPException(503, "Motor Rust ainda não foi compilado.")
    try:
        parse_target(body.algorithm, body.target)
    except (ValueError, TypeError) as error:
        raise HTTPException(422, str(error)) from error
    payload = body.model_dump()
    if body.device == "gpu":
        payload["gpu_device_id"] = body.gpu_device_id or device_ids[0]
        payload["workers"] = 1
    payload["target"] = body.target.strip()
    payload["block_size"] = body.block_size or (4096 if body.algorithm in ("md5", "sha512") else 64)
    payload["count"] = lab.experiments[body.experiment_id]["dataset"]["count"]
    payload["known_position"] = lab.experiments[body.experiment_id]["dataset"]["position"]
    job = Job(payload, state={"status": "queued", "attempts": 0, "elapsed": 0})
    lab.jobs[job.id] = job
    lab.executor.submit(lab.execute, job)
    return job.snapshot()


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    if job_id not in app.state.lab.jobs:
        raise HTTPException(404, "Execução não encontrada.")
    return app.state.lab.jobs[job_id].snapshot()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    if job_id not in app.state.lab.jobs:
        raise HTTPException(404, "Execução não encontrada.")
    job = app.state.lab.jobs[job_id]
    with job.lock:
        if job.state["status"] in ("found", "exhausted", "cancelled", "timeout", "error"):
            return {"requested": False}
        job.cancel_requested_at = job.cancel_requested_at or time.perf_counter()
        job.cancel.set()
        if job.state["status"] == "queued":
            job.state.update(status="cancelled", stop_latency=0.0)
    return {"requested": True}


@app.get("/")
def index():
    return FileResponse(ROOT / "index.html")


@app.get("/assets/{name:path}")
def asset(name: str):
    assets = (ROOT / "assets").resolve()
    selected = (assets / name).resolve()
    if assets not in selected.parents or not selected.is_file():
        raise HTTPException(404)
    return FileResponse(selected)


def main():
    import multiprocessing
    multiprocessing.freeze_support()
    print("\nPapocaHash · http://127.0.0.1:8765\nAbra index.html. Ctrl+C encerra o servidor.\n")
    uvicorn.run(app, host="127.0.0.1", port=8765, access_log=False)


if __name__ == "__main__":
    main()
