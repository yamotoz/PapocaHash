"""Cargas sem correspondência: cada comparação faz exatamente o mesmo trabalho."""
import argparse
import json
import os
import statistics
import time

from backend.crypto import hashes
from backend.dataset import ROOT, prepare
from backend.metrics import Resources
from backend.python_engine import PythonEngine
from backend.rust_engine import run as rust_run


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--algorithm", choices=("md5", "sha512", "bcrypt", "argon2id"), default="md5")
    parser.add_argument("--count", type=int, default=1_000_000)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--tune-blocks", action="store_true")
    parser.add_argument("--no-telemetry", action="store_true")
    args = parser.parse_args()
    if args.count < 1 or args.repeats < 1:
        parser.error("count e repeats devem ser positivos")
    snapshot = prepare("palavra-na-lista", args.count, args.count)
    target = hashes("ausente-da-lista")[args.algorithm]
    sizes = ([1024, 4096, 16384] if args.algorithm in ("md5", "sha512") else [16, 64, 256]) if args.tune_blocks else ([4096] if args.algorithm in ("md5", "sha512") else [64])
    rows = []
    for workers in sorted({1, os.cpu_count() or 1, *[n for n in (2, 4, 8, 16) if n <= (os.cpu_count() or 1)]}):
        pool = PythonEngine(workers)
        try:
            for engine in ("python-iterative", "python-recursive", "rust"):
                for block in sizes:
                    durations, runs = [], []
                    for _ in range(args.repeats):
                        metrics = Resources()
                        def update(attempts, elapsed, pids):
                            if not args.no_telemetry:
                                metrics.sample(pids)
                        if engine == "rust":
                            result = rust_run(snapshot, args.algorithm, target, workers, block, update, lambda: False)
                        else:
                            result = pool.run(snapshot, args.algorithm, target, engine, block, update, lambda: False)
                        assert result["status"] == "exhausted" and result["attempts"] == args.count
                        durations.append(result["elapsed"])
                        runs.append({**result, **metrics.summary(result.get("cpu_seconds"), result["elapsed"])})
                    row = {"engine": engine, "workers": workers, "block_size": block, "median_seconds": statistics.median(durations), "stdev_seconds": statistics.stdev(durations) if len(durations) > 1 else 0, "runs": runs}
                    rows.append(row)
                    print(f"{engine:19} {workers:2} trabalhadores  bloco={block:5}  mediana={row['median_seconds']:.6f}s", flush=True)
        finally:
            pool.close()
    output = ROOT / "data" / "benchmarks"
    output.mkdir(parents=True, exist_ok=True)
    report = {"algorithm": args.algorithm, "count": args.count, "telemetry": not args.no_telemetry, "repeats": args.repeats, "results": rows}
    (output / f"{args.algorithm}-{int(time.time())}.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
