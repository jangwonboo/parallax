"""vlmparse CLI.

    vlmparse read book.pdf --pages 1-20 --out book.json
    vlmparse read book.pdf --out book.json --assets-dir figs/
    vlmparse md   book.json                  # 뽑아 둔 것을 Markdown 으로
    vlmparse backends
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

from . import __version__, backends, read_pdf
from .render import DEFAULT_DPI, DEFAULT_LONG_EDGE
from .schema import Document

MD_HEAD = {"h1": "# ", "h2": "## ", "h3": "### "}


def to_markdown(doc: Document) -> str:
    """블록 → Markdown. 수식은 이미 `$…$`/`$$…$$` 라 그대로 흘려보낸다."""
    out: list[str] = []
    for b in doc.blocks:
        t, x = b.type, b.text
        if t == "figure":
            out.append(f"\n![그림](asset:{x})\n")
        elif t in MD_HEAD:
            out.append(f"\n{MD_HEAD[t]}{x}\n")
        elif t == "equation":
            out.append(f"\n{x}\n")
        elif t == "table_raw":
            out.append(f"\n{x}\n")
        elif t == "footnote":
            out.append(f"\n<sub>{x}</sub>\n")
        elif t == "figcaption":
            out.append(f"\n*{x}*\n")
        else:
            out.append(f"\n{x}\n")
    return "".join(out).replace("\n\n\n", "\n\n").lstrip("\n")


def dump_assets(doc: Document, dest: Path) -> int:
    dest.mkdir(parents=True, exist_ok=True)
    for aid, a in doc.assets.items():
        ext = "jpg" if a.mime == "image/jpeg" else "png"
        (dest / f"{aid}.{ext}").write_bytes(base64.b64decode(a.b64))
    return len(doc.assets)


def cmd_read(args: argparse.Namespace) -> int:
    def progress(done: int, total: int) -> None:
        pct = done * 100 // max(1, total)
        print(f"\r  {done}/{total} 쪽 ({pct}%)", end="", file=sys.stderr, flush=True)

    doc = read_pdf(
        args.pdf, backend=args.backend, pages=args.pages, mode=args.mode,
        dpi=args.dpi, long_edge=args.long_edge, image_format=args.image_format,
        workers=args.workers, api_key=args.api_key, work_dir=args.work_dir,
        use_cache=not args.no_cache, on_progress=None if args.quiet else progress,
    )
    if not args.quiet:
        print(file=sys.stderr)

    out = Path(args.out) if args.out else None
    if out and out.suffix.lower() == ".md":
        out.write_text(to_markdown(doc), encoding="utf-8")
    elif out:
        out.write_text(json.dumps(doc.to_dict(), ensure_ascii=False, indent=1),
                       encoding="utf-8")
    else:
        json.dump(doc.to_dict(), sys.stdout, ensure_ascii=False, indent=1)
        print()

    if args.assets_dir:
        n = dump_assets(doc, Path(args.assets_dir))
        print(f"  그림 {n}장 → {args.assets_dir}", file=sys.stderr)

    kinds: dict[str, int] = {}
    for b in doc.blocks:
        kinds[b.type] = kinds.get(b.type, 0) + 1
    print(f"  쪽 {len(doc.pages)} · 블록 {len(doc.blocks)} "
          f"({' · '.join(f'{k} {v}' for k, v in sorted(kinds.items()))}) "
          f"· 그림 {len(doc.assets)}", file=sys.stderr)
    if doc.cost.pages:
        print(f"  {args.backend} 지출: {doc.cost.pages}쪽 ≈ ${doc.cost.usd:.2f}",
              file=sys.stderr)
    # 실패는 크게 알린다 — 빈 쪽은 조용해서 눈치채기 어렵다.
    if doc.failed_pages:
        print(f"  ! 판독 실패 {len(doc.failed_pages)}쪽: "
              f"{doc.failed_pages[:12]}{' …' if len(doc.failed_pages) > 12 else ''}",
              file=sys.stderr)
        print("    다시 돌리면 성공분은 캐시에서 공짜로 건너뜁니다.", file=sys.stderr)
        return 1
    return 0


def cmd_md(args: argparse.Namespace) -> int:
    doc = Document.from_dict(json.loads(Path(args.json).read_text(encoding="utf-8")))
    text = to_markdown(doc)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


def cmd_backends(_: argparse.Namespace) -> int:
    for name in backends.available():
        print(name)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="vlmparse",
                                 description="PDF → VLM OCR → 구조 있는 블록")
    ap.add_argument("--version", action="version", version=f"vlmparse {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("read", help="PDF 를 읽어 JSON(또는 md)으로")
    r.add_argument("pdf")
    r.add_argument("--backend", default="datalab", choices=backends.available())
    r.add_argument("--out", help="산출 파일. .md 면 Markdown, 아니면 JSON. 없으면 stdout")
    r.add_argument("--pages", help="1-20 · 3 · 1-5,9,12-14 (기본: 전부)")
    r.add_argument("--mode", default="accurate", choices=("fast", "balanced", "accurate"),
                   help="fast 는 텍스트 레이어를 긁어 인라인 수식을 놓친다")
    r.add_argument("--dpi", type=int, default=DEFAULT_DPI)
    r.add_argument("--long-edge", type=int, default=DEFAULT_LONG_EDGE)
    r.add_argument("--image-format", default="jpg", choices=("jpg", "png"))
    r.add_argument("--workers", type=int, default=8)
    r.add_argument("--api-key")
    r.add_argument("--work-dir", help="쪽 이미지와 캐시가 놓일 곳")
    r.add_argument("--no-cache", action="store_true",
                   help="캐시를 쓰지 않는다 — 재실행이 전부 다시 과금된다")
    r.add_argument("--assets-dir", help="그림을 파일로도 뽑는다")
    r.add_argument("--quiet", action="store_true")
    r.set_defaults(func=cmd_read)

    m = sub.add_parser("md", help="뽑아 둔 JSON → Markdown")
    m.add_argument("json")
    m.add_argument("--out")
    m.set_defaults(func=cmd_md)

    b = sub.add_parser("backends", help="쓸 수 있는 백엔드")
    b.set_defaults(func=cmd_backends)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("\n멈췄습니다. 다시 돌리면 캐시에서 이어집니다.", file=sys.stderr)
        return 130
    except Exception as e:
        print(f"vlmparse: {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
