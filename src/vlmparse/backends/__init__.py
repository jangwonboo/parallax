"""백엔드 등록소.

백엔드는 「쪽 이미지 → 블록」 하나만 하면 된다. 새 백엔드(docling·mineru 등)를
붙이려면 이 파일에 한 줄 추가하고 같은 두 함수를 내놓으면 된다 —
`read_page(img, key, mode, spend)` 와 `chunks_to_blocks(chunks)`.
"""
from __future__ import annotations

from typing import Any

_REGISTRY: dict[str, str] = {
    "datalab": "vlmparse.backends.datalab",
}


def available() -> list[str]:
    return sorted(_REGISTRY)


def load(name: str) -> Any:
    if name not in _REGISTRY:
        raise KeyError(f"unknown backend {name!r} — 쓸 수 있는 것: {', '.join(available())}")
    import importlib
    return importlib.import_module(_REGISTRY[name])
