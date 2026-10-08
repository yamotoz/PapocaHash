"""Um pool por sessão; workers recebem índices, nunca a lista inteira."""
from concurrent.futures import FIRST_EXCEPTION, ProcessPoolExecutor, as_completed, wait
from contextlib import ExitStack
import mmap
import multiprocessing as mp
from pathlib import Path
import time

from .crypto import verifier
from .kernels import iterative, recursive

_context = None
_control = None


def initialize(control):
    global _control
    _control = control


def load(dataset, algorithm, target):
    global _context
    key = (dataset["id"], algorithm, target)
    if _context and _context[0] == key:
        return _context[1:]
    if _context:
        _context[-1].close()
        _context = None
    with ExitStack() as resources:
        text_file = resources.enter_context(Path(dataset["text"]).open("rb"))
        index_file = resources.enter_context(Path(dataset["index"]).open("rb"))
        text = resources.enter_context(mmap.mmap(text_file.fileno(), 0, access=mmap.ACCESS_READ))
        index = resources.enter_context(mmap.mmap(index_file.fileno(), 0, access=mmap.ACCESS_READ))
        offsets = memoryview(index).cast("Q")
        resources.callback(offsets.release)
        if len(offsets) != dataset["count"] + 1:
            raise ValueError("Índice incompatível com a wordlist.")
        check = verifier(algorithm, target)
        _context = key, text, offsets, check, resources.pop_all()
    return _context[1:]


class Stopped(Exception):
    pass


def worker(worker_id, dataset, algorithm, target, strategy, block_size):
    text, offsets, verify, _ = load(dataset, algorithm, target)
    next_block, stop, counts, ready, gate = _control
    slot = worker_id * 8
    counts[slot] = 0
    ready[worker_id] = 1
    gate.wait()
    used_cpu, attempts = time.process_time(), 0
    kernel = recursive if strategy == "python-recursive" else iterative
    interval = 256 if algorithm in ("md5", "sha512") else 1
    found = None
    started = time.perf_counter()

    def check(word):
        nonlocal attempts
        # Sincronizar em lotes mantém o GIL/IPC fora das tentativas rápidas.
        if attempts % interval == 0:
            counts[slot] = attempts
            if stop.is_set():
                raise Stopped
            # Uma posição por lote, na mesma linha de cache do contador.
            counts[slot + 1] = begin + attempts - block_start + 1
        attempts += 1
        return verify(word)

    try:
        while not stop.is_set():
            with next_block.get_lock():
                begin = next_block.value
                next_block.value += block_size
            if begin >= dataset["count"]:
                break
            end = min(begin + block_size, dataset["count"])
            block_start = attempts
            words = text[offsets[begin]:offsets[end]].splitlines()
            index = kernel(words, check)
            counts[slot] = attempts
            if attempts > block_start:
                counts[slot + 1] = begin + attempts - block_start
            if index is not None:
                found = {"word": words[index].decode("utf-8"), "position": begin + index + 1,
                         "matched_at": time.perf_counter()}
                stop.set()
                break
    except Stopped:
        pass
    counts[slot] = attempts
    return {"attempts": attempts, "cpu_seconds": time.process_time() - used_cpu,
            "found": found, "finished_at": time.perf_counter(), "worker_seconds": time.perf_counter() - started}


class PythonEngine:
    def __init__(self, workers):
        self.workers = workers
        self.broken = False
        context = mp.get_context("spawn")
        # Oito inteiros por slot: 64 bytes separam os contadores de cada CPU.
        self.control = (context.Value("Q", 0), context.Event(),
                        context.Array("Q", workers * 8, lock=False),
                        context.Array("b", workers, lock=False), context.Event())
        self.pool = ProcessPoolExecutor(workers, mp_context=context,
                                        initializer=initialize, initargs=(self.control,))

    @property
    def pids(self):
        return [process.pid for process in self.pool._processes.values()]

    def run(self, dataset, algorithm, target, strategy, block_size, update, cancelled,
            timeout=None, on_candidates=None):
        next_block, stop, counts, ready, gate = self.control
        stop.clear()
        gate.clear()
        next_block.value = 0
        for i in range(self.workers):
            counts[i * 8], ready[i] = 0, 0
            counts[i * 8 + 1] = 0
        setup_start = time.perf_counter()
        futures = [self.pool.submit(worker, i, dataset, algorithm, target, strategy, block_size)
                   for i in range(self.workers)]
        # Barreiras separam spawn/mapeamento do tempo real de busca.
        while not all(ready):
            if cancelled():
                stop.set()
            for future in futures:
                if future.done() and future.exception():
                    error = future.exception()
                    self.abort(futures)
                    raise error
            if time.perf_counter() - setup_start > 60:
                self.abort(futures)
                raise RuntimeError("Os processos Python não ficaram prontos em 60 segundos.")
            time.sleep(.01)
        started = time.perf_counter()
        gate.set()
        reason = "cancelled" if cancelled() else None
        requested_at = started if reason else None
        try:
            while not all(f.done() for f in futures):
                for future in futures:
                    if future.done() and future.exception():
                        raise future.exception()
                elapsed = time.perf_counter() - started
                if reason is None and (cancelled() or (timeout is not None and elapsed >= timeout)):
                    reason = "cancelled" if cancelled() else "timeout"
                    requested_at = time.perf_counter()
                    stop.set()
                if on_candidates:
                    on_candidates(list(counts[1::8]))
                update(sum(counts[::8]), elapsed, self.pids)
                interval = min(.1, max(.001, timeout - elapsed)) if timeout and reason is None else .1
                wait(futures, timeout=interval, return_when=FIRST_EXCEPTION)
            results = [future.result() for future in as_completed(futures)]
        except BaseException:
            self.abort(futures)
            raise
        ended = time.perf_counter()
        matches = [r["found"] for r in results if r["found"]]
        found = min(matches, key=lambda match: match["matched_at"]) if matches else None
        # O polling não entra no tempo de busca: usar o relógio dos trabalhadores.
        elapsed = max(result["finished_at"] for result in results) - started
        attempts = sum(result["attempts"] for result in results)
        if on_candidates:
            on_candidates(list(counts[1::8]))
        update(attempts, elapsed, self.pids)
        return {"status": "found" if found else reason or "exhausted", "attempts": attempts,
                "elapsed": elapsed, "setup_seconds": started - setup_start,
                "match_seconds": found["matched_at"] - started if found else None,
                "cpu_seconds": sum(result["cpu_seconds"] for result in results),
                "word": found["word"] if found else None,
                "position": found["position"] if found else None,
                "stop_latency": ended - requested_at if requested_at else None}

    def abort(self, futures):
        self.control[1].set()
        self.control[4].set()
        # Recolher a execução antes de reutilizar flags/contadores compartilhados.
        _, pending = wait(futures, timeout=5)
        if pending:
            self.broken = True
            for process in list(self.pool._processes.values()):
                if process.is_alive():
                    process.terminate()
                process.join(timeout=1)

    def close(self):
        self.control[1].set()
        self.control[4].set()
        self.pool.shutdown(wait=True, cancel_futures=True)
