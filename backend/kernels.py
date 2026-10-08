"""A estratégia muda; verificação, contagem e cancelamento são idênticos."""


def iterative(words, check):
    # Enumerar o bloco evita índice/decodificação no caminho crítico.
    for index, word in enumerate(words):
        if check(word):
            return index
    return None


def recursive(words, check, lo=0, hi=None):
    hi = len(words) if hi is None else hi
    if lo >= hi:
        return None
    if hi - lo == 1:
        return lo if check(words[lo]) else None
    # Divisão equilibrada: todos os candidatos, pilha O(log bloco).
    mid = (lo + hi) // 2
    found = recursive(words, check, lo, mid)
    return found if found is not None else recursive(words, check, mid, hi)
