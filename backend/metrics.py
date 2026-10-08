"""Métricas do trabalho; GPU é global e não implica aceleração da busca."""
import shutil
import subprocess
import threading
import psutil


class Resources:
    def __init__(self):
        self.processes = {}
        self.cpu_peak = self.memory_peak = 0
        self.samples = []

    def sample(self, pids):
        cpu = memory = 0
        measured = False
        for pid in pids:
            try:
                existing = pid in self.processes
                if pid not in self.processes:
                    self.processes[pid] = psutil.Process(pid)
                    self.processes[pid].cpu_percent()
                process = self.processes[pid]
                with process.oneshot():
                    cpu += process.cpu_percent()
                    memory += process.memory_info().rss
                    measured |= existing
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        cpu /= psutil.cpu_count() or 1
        if measured:
            self.cpu_peak = max(self.cpu_peak, cpu)
            self.samples.append(cpu)
        self.memory_peak = max(self.memory_peak, memory)
        return {"cpu": round(cpu, 2) if measured else None, "memory_mb": round(memory / 2**20, 2)}

    def summary(self, cpu_seconds=None, elapsed=0):
        average = (cpu_seconds / elapsed / (psutil.cpu_count() or 1) * 100
                   if cpu_seconds is not None and elapsed else
                   sum(self.samples) / max(1, len(self.samples)))
        return {"cpu_average": round(average, 2) if cpu_seconds is not None or self.samples else None,
                "cpu_peak": round(self.cpu_peak, 2) if self.samples else None,
                "memory_peak_mb": round(self.memory_peak / 2**20, 2)}


class GPU:
    def __init__(self):
        self.value = {"available": False, "name": None, "usage": None,
                      "memory_mb": None, "scope": "system", "accelerates_search": False}
        self.stop = threading.Event()
        if shutil.which("nvidia-smi"):
            threading.Thread(target=self.poll, daemon=True).start()

    def poll(self):
        while not self.stop.is_set():
            try:
                output = subprocess.check_output(
                    ["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used", "--format=csv,noheader,nounits"],
                    text=True, timeout=3, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                name, usage, memory = output.splitlines()[0].split(", ")
                self.value = {"available": True, "name": name, "usage": float(usage),
                              "memory_mb": float(memory), "scope": "system", "accelerates_search": False}
            except (OSError, ValueError, subprocess.SubprocessError):
                self.value["available"] = False
            self.stop.wait(1)
