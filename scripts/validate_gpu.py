"""Smoke test real de todos os modos, sem substituir por resultados simulados."""
import json
from backend.crypto import hashes
from backend.dataset import prepare, ROOT
from backend.gpu_engine import discover, run


def main():
    capability = discover()
    if not capability["available"]:
        raise RuntimeError(capability["reason"])
    device = capability["devices"][0]
    snapshot = prepare("ação-GPU🔷", position=37, size=37)
    results = {}
    for algorithm, target in hashes("ação-GPU🔷").items():
        print(f"Validando {algorithm} em {device['name']}…", flush=True)
        result = run(snapshot, algorithm, target, device["id"], lambda *args: None, lambda: False, timeout=300)
        if result["status"] != "found" or result["word"] != "ação-GPU🔷" or result["position"] != 37:
            raise RuntimeError(f"O teste real de {algorithm} falhou: {result}")
        results[algorithm] = result
    report = ROOT / ".runtime" / "gpu-validation.json"
    report.write_text(json.dumps({"capability": capability, "results": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Quatro hashes validados na GPU. Relatório: {report}")


if __name__ == "__main__":
    main()
