"""Protocolo NDJSON: stdout só transporta eventos, stdin permite cancelamento."""
import json
import queue
import subprocess
import threading
import time

from .dataset import ROOT

EXECUTABLE = ROOT / "target" / "release" / "papocahash-engine.exe"


def run(dataset, algorithm, target, workers, block_size, update, cancelled, timeout=None, on_candidates=None):
    if not EXECUTABLE.exists():
        raise RuntimeError("Motor Rust indisponível. Execute server.bat para compilar.")
    process = subprocess.Popen([str(EXECUTABLE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, encoding="utf-8",
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    events = queue.Queue()
    def read():
        try:
            for line in process.stdout:
                events.put(json.loads(line))
        except (ValueError, OSError) as error:
            events.put({"type": "error", "message": str(error)})
        finally:
            events.put(None)
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    request = {**{key: dataset[key] for key in ("text", "index", "count")},
               "algorithm": algorithm, "target": target, "workers": workers,
               "block_size": block_size, "timeout": timeout}
    process.stdin.write(json.dumps(request) + "\n")
    process.stdin.flush()
    cancellation = None
    result = None
    try:
        while True:
            if cancelled() and cancellation is None:
                cancellation = time.perf_counter()
                try:
                    process.stdin.write("cancel\n")
                    process.stdin.flush()
                except (BrokenPipeError, OSError):
                    pass
            if cancellation and time.perf_counter() - cancellation > 5:
                raise RuntimeError("O motor Rust não respondeu ao cancelamento em 5 segundos.")
            try:
                event = events.get(timeout=.1)
            except queue.Empty:
                if process.poll() is not None and not reader.is_alive():
                    break
                continue
            if event is None:
                break
            if event["type"] == "started":
                continue
            elif event["type"] == "progress":
                if on_candidates:
                    on_candidates(event.get("candidate_positions", []))
                update(event["attempts"], event["elapsed"], [process.pid])
            elif event["type"] == "result":
                result = event["result"]
                if cancellation:
                    result["stop_latency"] = time.perf_counter() - cancellation
                if on_candidates:
                    on_candidates(event.get("candidate_positions", []))
                update(result["attempts"], result["elapsed"], [process.pid])
                break
            elif event["type"] == "error":
                raise RuntimeError(event["message"])
        if result is None:
            raise RuntimeError(process.stderr.read() or "O motor Rust encerrou sem resultado.")
        return result
    finally:
        if process.poll() is None:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        reader.join(timeout=1)
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()
