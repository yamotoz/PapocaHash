import inspect
import os
from . import kernels
from .dataset import ROOT
from .rust_engine import EXECUTABLE


def lines(function):
    return sum(bool(line.strip()) and not line.lstrip().startswith("#")
               for line in inspect.getsource(function).splitlines())


def catalog():
    rust = (ROOT / "rust-engine" / "src" / "kernel.rs").read_text(encoding="utf-8")
    core = rust.split("#[cfg(test)]", 1)[0]
    rust_lines = sum(bool(line.strip()) and not line.lstrip().startswith("//") for line in core.splitlines())
    return {"workers": os.cpu_count() or 1, "complexity": "O(n × H)", "engines": [
        {"id": "python-iterative", "name": "Python iterativo", "language": "Python", "strategy": "Iterativo · multiprocessos", "lines": lines(kernels.iterative), "available": True},
        {"id": "python-recursive", "name": "Python recursivo", "language": "Python", "strategy": "Recursivo · multiprocessos", "lines": lines(kernels.recursive), "available": True},
        {"id": "rust", "name": "Rust paralelo", "language": "Rust", "strategy": "Iterativo · múltiplas threads", "lines": rust_lines, "available": EXECUTABLE.exists()},
    ]}
