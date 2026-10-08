"""Hashcat OpenCL: somente dispositivos GPU; sem fallback para CPU."""
from collections import deque
import json
from pathlib import Path
import queue
import re
import subprocess
import threading
import time
import uuid

from .crypto import verifier
from .dataset import ROOT

MODES = {"md5": 0, "sha512": 1700, "bcrypt": 3200, "argon2id": 34000}
GPU_FLAGS = ["--backend-ignore-cuda", "--backend-ignore-hip", "--backend-ignore-metal", "-D", "2"]
HIDDEN = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def executable():
    return next(iter(sorted((ROOT / ".runtime").glob("hashcat*/hashcat.exe"))), None)


def parse_devices(output):
    devices = []
    for section in re.split(r"Backend Device ID #", output)[1:]:
        device_id = re.match(r"(\d+)", section)
        name = re.search(r"Name\.+:\s*([^\r\n]+)", section)
        if device_id and name and re.search(r"Type\.+:\s*GPU\b", section):
            devices.append({"id": int(device_id[1]), "name": name[1].strip()})
    return devices


def discover():
    binary = executable()
    if not binary:
        return {"available": False, "reason": "Execute setup-gpu.bat para preparar o motor GPU.", "devices": []}
    try:
        version = subprocess.check_output([str(binary), "--version"], cwd=binary.parent,
                                          text=True, timeout=10, creationflags=HIDDEN).strip()
        major = re.match(r"v?(\d+)", version)
        if not major or int(major[1]) < 7:
            raise RuntimeError("Hashcat 7 ou superior é necessário para Argon2id.")
        result = subprocess.run([str(binary), "--backend-info", *GPU_FLAGS], cwd=binary.parent,
                                capture_output=True, text=True, errors="replace", timeout=20, creationflags=HIDDEN)
        devices = parse_devices(result.stdout)
        if result.returncode or not devices:
            raise RuntimeError("Hashcat não detectou GPU OpenCL. Verifique o driver da placa e execute setup-gpu.bat novamente.")
        return {"available": True, "reason": "", "version": version, "devices": devices, "backend": "OpenCL"}
    except (OSError, subprocess.SubprocessError, RuntimeError) as error:
        return {"available": False, "reason": str(error), "devices": []}


class Backend:
    def __init__(self):
        self.value = {"available": False, "reason": "Verificando o motor GPU…", "devices": []}
        self.stop = threading.Event()
        threading.Thread(target=self.poll, daemon=True).start()

    def poll(self):
        while not self.stop.is_set():
            self.value = discover()
            self.stop.wait(30)


def command(binary, directory, dataset, algorithm, device_id):
    # Sem -O: preservar o suporte a palavras longas. Sem potfile: buscar de novo.
    return [str(binary), "-m", str(MODES[algorithm]), "-a", "0", *GPU_FLAGS,
            "-d", str(device_id), "-w", "3", "--status", "--status-json", "--status-timer", "1",
            "--potfile-disable", "--restore-disable", "--logfile-disable", "--wordlist-autohex-disable",
            "--session", directory.name, "--outfile", str(directory / "found.txt"), "--outfile-format", "3",
            str(directory / "target.txt"), dataset["text"]]


def run(dataset, algorithm, target, device_id, update, cancelled, timeout=None):
    binary = executable()
    if not binary:
        raise RuntimeError("Motor GPU ausente. Execute setup-gpu.bat.")
    directory = ROOT / ".runtime" / "gpu-runs" / uuid.uuid4().hex
    directory.mkdir(parents=True)
    (directory / "target.txt").write_text(target + "\n", encoding="utf-8")
    events, logs = queue.Queue(), deque(maxlen=25)
    started = time.perf_counter()
    process = subprocess.Popen(command(binary, directory, dataset, algorithm, device_id), cwd=binary.parent,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                               text=True, encoding="utf-8", errors="replace", creationflags=HIDDEN)
    def read():
        try:
            for line in process.stdout:
                events.put(line)
        finally:
            events.put(None)
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    attempts, requested, reason = 0, None, None
    reported, finished_json = False, None
    utilization, last_status = [], None
    try:
        while True:
            elapsed = time.perf_counter() - started
            if requested is None and (cancelled() or (timeout is not None and elapsed >= timeout)):
                reason = "cancelled" if cancelled() else "timeout"
                requested = time.perf_counter()
                process.terminate()
            if requested and time.perf_counter() - requested > 3 and process.poll() is None:
                process.kill()
            try:
                line = events.get(timeout=.1)
            except queue.Empty:
                update(attempts, elapsed, [process.pid])
                continue
            if line is None:
                break
            logs.append(line.rstrip())
            try:
                status = json.loads(line)
            except (ValueError, TypeError):
                continue
            if not isinstance(status, dict) or "progress" not in status:
                continue
            devices = status.get("devices", [])
            if devices and any(device.get("device_type") != "GPU" for device in devices):
                raise RuntimeError("Hashcat retornou um dispositivo que não é GPU; execução interrompida.")
            reported, last_status = True, status
            attempts = max(attempts, min(dataset["count"], max(0, int(status["progress"][0]) - int(status.get("rejected", 0)))))
            utilization.extend(device["util"] for device in devices if 0 <= device.get("util", -1) <= 100)
            update(attempts, elapsed, [process.pid])
            if status.get("status") in (5, 6, 7, 8, 9, 10, 11):
                finished_json = elapsed
        process.wait(timeout=3)
        elapsed = finished_json if finished_json is not None else time.perf_counter() - started
        (directory / "engine.log").write_text("\n".join(logs), encoding="utf-8")
        found_file = directory / "found.txt"
        word = position = None
        if found_file.exists() and found_file.read_text(encoding="ascii").strip():
            encoded = bytes.fromhex(found_file.read_text(encoding="ascii").splitlines()[0].strip())
            word = encoded.decode("utf-8")
            if not verifier(algorithm, target)(encoded):
                raise RuntimeError("O resultado da GPU não corresponde ao hash informado.")
            # A posição é consultada depois da descoberta, nunca entregue ao motor.
            with open(dataset["text"], "rb") as words:
                position = next((i for i, entry in enumerate(words, 1) if entry.rstrip(b"\n") == encoded), None)
            if position is None:
                raise RuntimeError("A GPU retornou uma palavra fora da wordlist do experimento.")
        if reason is None and (process.returncode not in (0, 1) or not reported):
            raise RuntimeError("O motor GPU não concluiu uma execução válida. " + "\n".join(logs)[-1600:])
        status = "found" if word is not None else reason or "exhausted"
        if status == "exhausted" and (not last_status or last_status.get("status") != 5):
            raise RuntimeError("A GPU encerrou sem confirmar que a lista foi esgotada.")
        update(attempts, elapsed, [process.pid])
        return {"status": status, "attempts": attempts, "elapsed": elapsed, "word": word, "position": position,
                "match_seconds": None, "setup_seconds": None, "cpu_seconds": None,
                "timing_scope": "end-to-end", "gpu_backend": "Hashcat OpenCL", "gpu_device_id": device_id,
                "gpu_average": sum(utilization) / len(utilization) if utilization else None,
                "gpu_peak": max(utilization) if utilization else None,
                "stop_latency": time.perf_counter() - requested if requested else None}
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        reader.join(timeout=1)
        process.stdout.close()
