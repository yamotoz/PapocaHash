"""Parâmetros de laboratório iguais nas duas linguagens."""
import hashlib
import secrets
import base64
import re
import bcrypt
from argon2.low_level import Type, hash_secret_raw

ALGORITHMS = ("md5", "sha512", "bcrypt", "argon2id")
ARGON = {"memory": 8192, "iterations": 2, "lanes": 1}


def hashes(word: str) -> dict:
    raw = word.encode("utf-8")
    salt = secrets.token_bytes(16)
    digest = hash_secret_raw(raw, salt, 2, 8192, 1, 32, Type.ID)
    b64 = lambda data: base64.b64encode(data).decode().rstrip("=")
    return {"md5": hashlib.md5(raw, usedforsecurity=False).hexdigest(),
            "sha512": hashlib.sha512(raw).hexdigest(),
            "bcrypt": bcrypt.hashpw(raw, bcrypt.gensalt(rounds=4)).decode(),
            "argon2id": f"$argon2id$v=19$m=8192,t=2,p=1${b64(salt)}${b64(digest)}"}


def parse_target(algorithm: str, target: str):
    target = target.strip()
    if algorithm in ("md5", "sha512"):
        length = 32 if algorithm == "md5" else 128
        if len(target) != length or not re.fullmatch(r"[0-9a-fA-F]+", target):
            raise ValueError(f"O hash deve ter {length} caracteres hexadecimais.")
        return bytes.fromhex(target)
    if algorithm == "bcrypt":
        parts = target.split("$")
        if len(target) != 60 or len(parts) != 4 or parts[1] not in ("2a", "2b", "2y") or parts[2] != "04":
            raise ValueError("Este laboratório aceita bcrypt válido com custo 04.")
        try:
            bcrypt.checkpw(b"validation", target.encode())
        except ValueError as error:
            raise ValueError("Hash bcrypt inválido.") from error
        return target.encode()
    if algorithm == "argon2id":
        parts = target.split("$")
        if len(parts) != 6 or parts[1:4] != ["argon2id", "v=19", "m=8192,t=2,p=1"]:
            raise ValueError("Use Argon2id v19 com m=8192,t=2,p=1, como no gerador.")
        decode = lambda value: base64.b64decode(value + "=" * (-len(value) % 4), validate=True)
        salt, digest = decode(parts[4]), decode(parts[5])
        if len(salt) != 16 or len(digest) != 32:
            raise ValueError("Argon2id requer salt de 16 bytes e digest de 32 bytes.")
        return salt, digest
    raise ValueError("Algoritmo desconhecido.")


def verifier(algorithm: str, target: str):
    parsed = parse_target(algorithm, target)
    if algorithm == "md5":
        md5 = hashlib.md5
        return lambda word: md5(word, usedforsecurity=False).digest() == parsed
    if algorithm == "sha512":
        sha512 = hashlib.sha512
        return lambda word: sha512(word).digest() == parsed
    if algorithm == "bcrypt":
        checkpw = bcrypt.checkpw
        return lambda word: checkpw(word, parsed)
    salt, digest = parsed
    raw_hash = hash_secret_raw
    return lambda word: raw_hash(word, salt, 2, 8192, 1, 32, Type.ID) == digest


def preview_hash(algorithm: str, target: str, word: str) -> str:
    """Hash de uma amostra com os mesmos parâmetros e salt do alvo."""
    raw = word.encode("utf-8")
    if algorithm == "md5":
        return hashlib.md5(raw, usedforsecurity=False).hexdigest()
    if algorithm == "sha512":
        return hashlib.sha512(raw).hexdigest()
    if algorithm == "bcrypt":
        return bcrypt.hashpw(raw, target.encode()).decode()
    salt, _ = parse_target(algorithm, target)
    digest = hash_secret_raw(raw, salt, 2, 8192, 1, 32, Type.ID)
    encoded = base64.b64encode(digest).decode().rstrip("=")
    return target.rsplit("$", 1)[0] + "$" + encoded
