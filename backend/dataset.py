"""Snapshots imutáveis: texto interoperável + offsets binários de acesso direto."""
from array import array
from pathlib import Path
import json
import random
import shutil
import uuid

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SIZE = 1_000_000


def metadata(directory: Path, count: int) -> dict:
    result = {"id": directory.name, "count": count,
              "text": str(directory / "wordlist1kk.txt"), "index": str(directory / "offsets.bin")}
    (directory / "metadata.json").write_text(json.dumps(result), encoding="utf-8")
    return result


def candidate(index: int) -> bytes:
    return f"papoca{index:07d}".encode("ascii")


def write_list(directory: Path, words) -> dict:
    directory.mkdir(parents=True, exist_ok=True)
    offsets, cursor = array("Q", [0]), 0
    text = directory / "wordlist1kk.txt"
    with text.open("wb", buffering=1 << 20) as output:
        for word in words:
            output.write(word + b"\n")
            cursor += len(word) + 1
            offsets.append(cursor)
    if offsets.itemsize != 8:
        raise RuntimeError("O índice requer inteiros de 64 bits.")
    with (directory / "offsets.bin").open("wb") as output:
        offsets.tofile(output)
    return metadata(directory, len(offsets) - 1)


def snapshot(directory: Path, changes: dict, size: int) -> dict:
    ensure_base()
    directory.mkdir(parents=True, exist_ok=True)
    base = DATA / "base"
    # Copiar trechos em vez de recriar um milhão de strings a cada inserção.
    with (base / "wordlist1kk.txt").open("rb") as source, (directory / "wordlist1kk.txt").open("wb") as output:
        def copy_bytes(count):
            while count:
                block = source.read(min(count, 1 << 20))
                if not block:
                    raise ValueError("A wordlist base está incompleta.")
                output.write(block)
                count -= len(block)
        cursor = 0
        for index, word in sorted(changes.items()):
            copy_bytes(index * 14 - cursor)
            source.seek(14, 1)
            output.write(word + b"\n")
            cursor = (index + 1) * 14
        copy_bytes(size * 14 - cursor)
    delta = [(index, len(word) - 13) for index, word in changes.items() if len(word) != 13]
    if not delta:
        shutil.copyfile(base / "offsets.bin", directory / "offsets.bin")
    else:
        offsets = array("Q")
        with (base / "offsets.bin").open("rb") as source:
            offsets.fromfile(source, size + 1)
        for index, shift in delta:
            for i in range(index + 1, size + 1):
                offsets[i] += shift
        with (directory / "offsets.bin").open("wb") as output:
            offsets.tofile(output)
    return metadata(directory, size)


def ensure_base() -> dict:
    path = DATA / "base" / "metadata.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return write_list(DATA / "base", (candidate(i) for i in range(SIZE)))


def prepare(word: str, position: int | None = None, size: int = SIZE) -> dict:
    encoded = word.encode("utf-8")
    if not encoded or len(encoded) > 72 or "\n" in word or "\r" in word or "\x00" in word:
        raise ValueError("Use uma palavra de 1 a 72 bytes UTF-8, sem quebra de linha ou NUL.")
    position = position if position is not None else random.SystemRandom().randint(500_000, SIZE)
    if not 1 <= position <= size:
        raise ValueError("Posição fora da lista.")
    selected = position - 1
    existing = None
    if encoded.startswith(b"papoca") and len(encoded) == 13:
        try:
            parsed = int(encoded[6:])
            if 0 <= parsed < size and candidate(parsed) == encoded:
                existing = parsed
        except ValueError:
            pass
    # Trocar uma palavra existente preserva a unicidade e a posição sorteada.
    def words():
        for i in range(size):
            yield encoded if i == selected else candidate(selected) if i == existing else candidate(i)
    directory = DATA / uuid.uuid4().hex
    changes = {selected: encoded}
    if existing is not None and existing != selected:
        changes[existing] = candidate(selected)
    result = snapshot(directory, changes, size) if size == SIZE else write_list(directory, words())
    result["position"] = position
    return result


if __name__ == "__main__":
    print(json.dumps(ensure_base(), ensure_ascii=False))
