"""vlmparse — PDF 를 VLM OCR 로 읽어 구조 있는 블록으로 뽑는다.

    from vlmparse import read_pdf
    doc = read_pdf("book.pdf", backend="datalab", pages="1-20")
    for b in doc.blocks:
        print(b.type, b.text[:60])

쓰는 쪽은 백엔드를 몰라도 된다 — 출력은 늘 `schema.Document` 다.
"""
from __future__ import annotations

# 회사·학교 망의 TLS 검사 장비는 트래픽을 자기 사설 CA 로 다시 서명한다. 그 CA 는
# OS 신뢰 저장소에는 있지만 파이썬이 들고 다니는 certifi 번들에는 없어서, 브라우저와
# curl 은 멀쩡한데 **파이썬 API 호출만** `CERTIFICATE_VERIFY_FAILED` 로 죽는다.
#
# truststore 는 검증을 OS 에 맡긴다 — 이 기계의 다른 프로그램과 같은 판단을 하게
# 하는 것이지 검증을 끄는 것이 아니다. 없으면 그냥 OpenSSL 기본값으로 간다.
try:                                                        # pragma: no cover
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass

from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable

from . import backends
from .cache import Cache, NullCache
from .render import DEFAULT_DPI, DEFAULT_LONG_EDGE, page_count, parse_pages, render_pages
from .schema import Asset, Block, Cost, Document, Page

__all__ = ["read_pdf", "Document", "Page", "Block", "Asset", "Cost", "backends"]
__version__ = "0.1.0"


def read_pdf(
    pdf: str | Path,
    *,
    backend: str = "datalab",
    pages: str | None = None,
    mode: str = "accurate",
    dpi: int = DEFAULT_DPI,
    long_edge: int = DEFAULT_LONG_EDGE,
    image_format: str = "jpg",
    workers: int = 8,
    api_key: str | None = None,
    work_dir: str | Path | None = None,
    use_cache: bool = True,
    on_progress: Callable[[int, int], None] | None = None,
) -> Document:
    """PDF 를 읽어 `Document` 로 돌려준다.

    한 쪽이 실패해도 전체를 멈추지 않는다 — 그 쪽만 `Page.error` 로 표시하고
    나머지를 계속한다. **빈 쪽은 조용하기 때문에** 실패를 반드시 남겨야 한다.
    """
    pdf = Path(pdf)
    be = backends.load(backend)
    key = be.find_key(api_key)
    if not key:
        raise RuntimeError(
            "DATALAB_API_KEY 가 없습니다. 환경변수로 넣거나 .env 에 적으세요 "
            "(https://www.datalab.to 에서 발급)."
        )

    total = page_count(pdf)
    page_nos = parse_pages(pages, total)
    work = Path(work_dir) if work_dir else pdf.parent / f".{pdf.stem}-vlmparse"
    cache = Cache(work) if use_cache else NullCache()
    imgs = render_pages(pdf, page_nos, work / "pages", dpi=dpi,
                        long_edge=long_edge, image_format=image_format)

    spend = be.Spend()

    def job(pno: int) -> tuple[int, dict]:
        # 캐시 키에는 **판독 결과를 바꾸는 모든 것**이 들어간다. dpi 만 올리고
        # 옛 결과를 받으면 왜 안 좋아지는지 알 수 없게 된다.
        k = cache.key(f"{backend}:{pno}", mode, dpi, long_edge, image_format)
        hit = cache.get(k)
        if hit is not None:
            return pno, hit
        try:
            chunks = be.read_page(imgs[pno], key, mode, spend)
            got = {"chunks": chunks}
            cache.put(k, got)
        except Exception as e:                       # 한 쪽 실패가 전체를 죽이지 않는다
            got = {"error": f"{type(e).__name__}: {e}"}
        return pno, got

    raw: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futs = [pool.submit(job, p) for p in page_nos]
        for i, fut in enumerate(as_completed(futs), 1):
            pno, got = fut.result()
            raw[pno] = got
            if on_progress:
                on_progress(i, len(page_nos))

    doc = Document(source=str(pdf), backend=backend,
                   cost=Cost(pages=spend.pages, usd=round(spend.usd, 4)))
    for pno in page_nos:                             # 쪽 순서는 지킨다
        got = raw[pno]
        if got.get("error"):
            doc.pages.append(Page(page=pno, error=got["error"]))
            continue
        items, assets = be.chunks_to_blocks(got.get("chunks") or [])
        for aid, a in assets.items():
            doc.assets.setdefault(aid, Asset(**a))
        doc.pages.append(Page(page=pno,
                              blocks=[Block(type=i["type"], text=i["text"]) for i in items]))
    return doc
