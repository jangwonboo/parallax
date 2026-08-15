"""쪽 단위 캐시.

쪽마다 돈이 나가는 판독에서 캐시는 편의가 아니라 **안전장치**다. 244쪽 책이
219쪽에서 죽어도 재실행이 완료분을 공짜로 건너뛴다 — 이것이 없으면 중간에
끊길 때마다 처음부터 다시 사야 한다.

키에는 쪽 번호뿐 아니라 **판독 결과를 바꾸는 모든 것**(모드·dpi·백엔드·키 버전)이
들어가야 한다. dpi 를 올려 놓고 옛 결과를 그대로 받으면 왜 안 좋아지는지 알 수
없게 된다.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any


class Cache:
    def __init__(self, root: Path | str, stage: str = "read") -> None:
        self.dir = Path(root) / ".vlmparse-cache" / stage
        self.dir.mkdir(parents=True, exist_ok=True)

    def key(self, payload: str, *salts: Any) -> str:
        h = hashlib.sha1()
        h.update(payload.encode("utf-8"))
        for s in salts:
            h.update(b"\x00")
            h.update(str(s).encode("utf-8"))
        return h.hexdigest()[:20]

    def get(self, key: str) -> dict | None:
        f = self.dir / f"{key}.json"
        if not f.exists():
            return None
        try:
            return json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            # 깨진 캐시는 없는 것으로 친다. 지우지는 않는다 — 동시에 쓰던
            # 워커가 있을 수 있고, 다음 put 이 어차피 덮는다.
            return None

    def put(self, key: str, value: dict) -> None:
        # 임시 파일에 쓰고 옮긴다. 여러 워커가 같은 폴더를 쓰는 데다, 도중에
        # 죽으면 반쪽짜리 JSON 이 남아 다음 실행이 그것을 「성공」으로 읽는다.
        f = self.dir / f"{key}.json"
        tmp = f.with_suffix(f".{id(value):x}.tmp")
        tmp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        tmp.replace(f)


class NullCache(Cache):
    """--no-cache 용. 늘 빗나가고 아무것도 안 남긴다."""

    def __init__(self) -> None:  # noqa: D107 - 부모의 mkdir 를 타지 않는다
        self.dir = Path(".")

    def get(self, key: str) -> dict | None:
        return None

    def put(self, key: str, value: dict) -> None:
        return None
