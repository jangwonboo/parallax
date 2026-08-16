r"""출력 계약.

이 파일이 이 패키지의 **약속**이다. 백엔드가 무엇이든(Datalab·나중에 docling 등)
`read_pdf()` 는 늘 이 모양을 낸다. 쓰는 쪽은 백엔드를 몰라도 된다.

블록 유형은 여덟뿐이다. 판독기가 주는 세밀한 분류를 여기서 한 번 좁힌다 —
하류(번역·조판·색인)가 다룰 수 있는 것만 남기고, 나머지는 버리거나 `p` 로
접는다. 좁히는 자리를 백엔드마다 두면 백엔드를 바꿀 때마다 하류가 흔들린다.

    h1 h2 h3     제목 세 단계
    p            본문. 인라인 수식은 `$…$` 로 남는다
    figcaption   그림 설명
    footnote     각주
    table_raw    표 — HTML 태그를 **보존한다**(구조가 곧 내용이다)
    equation     별행 수식 — LaTeX 를 `$$…$$` 로 감싸 보존한다
    figure       그림. text 는 본문이 아니라 asset id 다

**수식을 평문으로 뭉개지 않는 것이 이 스키마의 이유 중 하나다.** 앞선
파이프라인은 태그를 걷어내며 `<math>` 안의 LaTeX 를 맨몸으로 흘려보냈고,
그 결과 양자역학 책 본문에 `\Delta e \times \Delta d` 와 `h/2\pi` 가 산문처럼
박혔다(실측). 구분자가 없으면 하류는 그것이 수식인지 알 방법이 없다 —
번역기는 글로 보고 제멋대로 고치고, 리더는 그릴 수 없다. 표를 `table_raw` 로
살린 것과 같은 원리로, 수식도 **구조를 지운 채 글자만 남기면 안 된다.**
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

BLOCK_TYPES = ("h1", "h2", "h3", "p", "figcaption", "footnote",
               "table_raw", "equation", "figure")

#: 번역·교정이 건드리면 안 되는 유형. 수식과 그림은 언어가 없다.
NO_TRANSLATE = frozenset({"equation", "figure"})

SCHEMA_VERSION = 1


@dataclass
class Block:
    type: str
    text: str

    def __post_init__(self) -> None:
        if self.type not in BLOCK_TYPES:
            raise ValueError(f"unknown block type: {self.type!r}")


@dataclass
class Asset:
    """쪽에서 잘라 온 그림. id 는 **내용 sha1** 이고 딕셔너리 키로 쓴다.

    b64 를 그대로 싣는 것은 산출물 하나로 옮겨 다니게 하려는 것이다. 사이드카
    폴더로 빼면 JSON 하나만 복사했을 때 그림이 통째로 사라진다. 파일로 뽑고
    싶으면 CLI 의 --assets-dir 를 쓴다.
    """
    mime: str
    w: int
    h: int
    alt: str
    b64: str
    #: 원본 쪽 폭 대비 이 그림의 폭(0~1). 리더가 **원본에서 차지하던 비율대로**
    #: 그리게 하는 값이다 — 없으면 작은 아이콘도 칸 가득 늘어난다. 0 은 모름.
    wfrac: float = 0.0


@dataclass
class Page:
    page: int                      # 1-기반. 사람이 세는 쪽 번호와 맞춘다
    blocks: list[Block] = field(default_factory=list)
    error: str | None = None       # 이 쪽 판독이 실패했으면 사유

    @property
    def ok(self) -> bool:
        return self.error is None


@dataclass
class Cost:
    """실 호출에만 붙는 과금. 캐시 적중은 0원이라 여기 안 잡힌다.

    정답은 언제나 공급자 대시보드다 — 이 값은 「전 쪽을 태울지」 정하는 근거로
    쓰는 어림이다.
    """
    pages: int = 0
    usd: float = 0.0


@dataclass
class Document:
    source: str
    backend: str
    pages: list[Page] = field(default_factory=list)
    assets: dict[str, Asset] = field(default_factory=dict)
    cost: Cost = field(default_factory=Cost)
    schema_version: int = SCHEMA_VERSION

    # ---- 편의 ----
    @property
    def blocks(self) -> list[Block]:
        """쪽 경계를 지우고 문서 순서대로. 쪽이 필요 없는 쓰는 쪽을 위해."""
        return [b for p in self.pages for b in p.blocks]

    @property
    def failed_pages(self) -> list[int]:
        return [p.page for p in self.pages if not p.ok]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "source": self.source,
            "backend": self.backend,
            "pages": [
                {"page": p.page,
                 "blocks": [asdict(b) for b in p.blocks],
                 "error": p.error}
                for p in self.pages
            ],
            "assets": {k: asdict(v) for k, v in self.assets.items()},
            "cost": asdict(self.cost),
        }

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Document":
        return cls(
            source=d["source"],
            backend=d["backend"],
            pages=[Page(page=p["page"],
                        blocks=[Block(**b) for b in p.get("blocks") or []],
                        error=p.get("error"))
                   for p in d.get("pages") or []],
            assets={k: Asset(**v) for k, v in (d.get("assets") or {}).items()},
            cost=Cost(**(d.get("cost") or {})),
            schema_version=d.get("schema_version", SCHEMA_VERSION),
        )
