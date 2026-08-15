"""PDF → 쪽 이미지.

판독기에 보내는 것은 PDF 가 아니라 **쪽 그림**이다. 그래서 dpi·긴 변 상한·회색조가
비용과 품질을 동시에 정한다 — 크게 보낼수록 정확하지만 느리고 비싸다.

기본값(200dpi · 긴 변 2200px · 회색조 JPEG q75)은 본문 책에서 검증된 자리다.
표가 촘촘하거나 각주가 아주 작으면 dpi 를 올린다.
"""
from __future__ import annotations

from pathlib import Path

try:
    import fitz  # PyMuPDF
except ImportError as e:  # pragma: no cover - 설치 안내는 CLI 가 한다
    raise ImportError(
        "PyMuPDF 가 필요합니다: pip install pymupdf"
    ) from e

DEFAULT_DPI = 200
DEFAULT_LONG_EDGE = 2200
DEFAULT_QUALITY = 75


def media_type_of(path: Path) -> str:
    return "image/jpeg" if path.suffix.lower() in (".jpg", ".jpeg") else "image/png"


def page_count(pdf: Path | str) -> int:
    with fitz.open(pdf) as doc:
        return doc.page_count


def parse_pages(spec: str | None, total: int) -> list[int]:
    """`--pages` 를 1-기반 쪽 목록으로. `3` · `1-20` · `1-5,9,12-14` · None(전부).

    범위를 벗어난 쪽은 조용히 버린다 — 「1-9999」로 전권을 뜻하는 것이 흔하다.
    """
    if not spec:
        return list(range(1, total + 1))
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            lo, hi = int(a), int(b)
            out.extend(range(lo, hi + 1))
        else:
            out.append(int(part))
    seen: set[int] = set()
    return [p for p in out if 1 <= p <= total and not (p in seen or seen.add(p))]


def render_page(page, dest: Path, dpi: int = DEFAULT_DPI,
                long_edge: int = DEFAULT_LONG_EDGE,
                quality: int = DEFAULT_QUALITY, gray: bool = True) -> None:
    """한 쪽을 dest 로 래스터라이즈한다. dest 가 JPEG 면 압축해서 쓴다."""
    zoom = dpi / 72
    long_px = max(page.rect.width, page.rect.height) * zoom
    if long_px > long_edge:
        zoom *= long_edge / long_px
    pm = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom),
                         colorspace=fitz.csGRAY if gray else fitz.csRGB)
    if media_type_of(dest) != "image/jpeg":
        pm.save(dest)
        return
    try:
        pm.save(dest, jpg_quality=quality)
    except (TypeError, ValueError, RuntimeError):
        # 오래된 PyMuPDF 는 jpg 를 직접 못 쓴다.
        from PIL import Image
        Image.frombytes("L" if gray else "RGB", (pm.width, pm.height), pm.samples) \
             .save(dest, "JPEG", quality=quality, optimize=True)


def render_pages(pdf: Path | str, pages: list[int], dest_dir: Path,
                 dpi: int = DEFAULT_DPI, long_edge: int = DEFAULT_LONG_EDGE,
                 image_format: str = "jpg", quality: int = DEFAULT_QUALITY,
                 gray: bool = True) -> dict[int, Path]:
    """고른 쪽만 그린다. {쪽 번호: 이미지 경로}.

    전 쪽을 미리 그리지 않는다 — 수백 MB 가 나오고, 일부만 다시 읽을 때
    대부분이 버려진다.
    """
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    ext = "png" if image_format.lower() == "png" else "jpg"
    out: dict[int, Path] = {}
    with fitz.open(pdf) as doc:
        for pno in pages:
            dest = dest_dir / f"p{pno:04d}.{ext}"
            if not dest.exists():
                render_page(doc[pno - 1], dest, dpi, long_edge, quality, gray)
            out[pno] = dest
    return out
