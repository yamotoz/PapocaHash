"""Amostras limitadas: ler posições reais sem transportar a lista aos clientes."""
from contextlib import ExitStack
import mmap
import struct


class CandidatePreview:
    def __init__(self, dataset):
        self.count = dataset["count"]
        with ExitStack() as resources:
            def mapping(path):
                file = resources.enter_context(open(path, "rb"))
                return resources.enter_context(mmap.mmap(file.fileno(), 0, access=mmap.ACCESS_READ))
            self.text, self.index = mapping(dataset["text"]), mapping(dataset["index"])
            self.resources = resources.pop_all()

    def read(self, positions):
        candidates = []
        for worker, position in enumerate(positions[:16], 1):
            if 1 <= position <= self.count:
                start, end = struct.unpack_from("<QQ", self.index, (position - 1) * 8)
                candidates.append({"worker": worker, "position": position,
                                   "word": self.text[start:end - 1].decode("utf-8")})
        return candidates

    def close(self):
        self.resources.close()
