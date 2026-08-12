#!/usr/bin/env python3
"""개조식(nominal) 종결 검사 — `-다`로 샌 문장을 찾는다. 표준 라이브러리만 쓴다.

    python scripts/check_endings.py 초고.md
    python scripts/check_endings.py 초고.md --quiet     # 개수만, 누출이 있으면 exit 1
    cat 초고.md | python scripts/check_endings.py -     # 표준 입력

문체 사양만으로는 새는 자리가 남고, 누출률은 실행마다 0.6%~8.8%로 흔들린다.
누출은 **긴 문단의 가운데**에 몰린다 — 앞뒤는 명사형인데 중간 여섯 문장이 풀린다.
그러니 생성 → 검사 → 걸린 문단만 재요청 순으로 간다. 자세한 것은
`references/nominal.md`.

교정할 때는 **그 문단의 종결부만** 갈아 끼운다. 전체를 다시 쓰게 하면 문체 말고
다른 것이 함께 바뀐다.
"""
from __future__ import annotations

import argparse
import re
import sys

_SENT_SPLIT = re.compile(r"(?<=[.?!…])\s+")

# 종결 후보. `요` 단독은 보지 않는다 — `필요`·`중요`·`개요`·`수요`가 걸린다.
# 어미 형태만 본다.
_LEAK = re.compile(r"(다|하자|보자|어요|에요|예요|세요|지요|네요|군요|까요)$")

# 인용부호 안은 인물이 실제로 한 말이라 개조식으로 바꾸지 않는다(사양의 예외).
# 마스킹하지 않으면 대사의 `-습니다`가 누출로 잡히고, 규칙대로 손대지 않으므로
# 그 문장이 영원히 "아직 누출"로 남는다. 문장 분할에도 도움이 된다 — 대사 안의
# 마침표가 엉뚱한 자리에서 문장을 자르지 않는다.
_QUOTED = re.compile(r"[\"“'‘][^\"“”'‘’]{0,600}[\"”'’]")

# 마크다운 부속물. 표·코드·머리글·목록 마커는 문장이 아니다.
_FENCE = re.compile(r"^\s*(```|~~~)")
_SKIP_LINE = re.compile(r"^\s*(#{1,6}\s|\||>\s*$|-{3,}\s*$|={3,}\s*$)")
_LIST_MARK = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")


def leaky_sentences(text: str) -> list[str]:
    """명사형으로 끝나지 않은 문장들. 물음표 문장과 인용문은 사양상 예외다."""
    out = []
    for s in _SENT_SPLIT.split(_QUOTED.sub(" ", text or "")):
        s = s.strip()
        if not s or s.endswith("?"):
            continue
        if _LEAK.search(s.rstrip(".!…)】]")):
            out.append(s)
    return out


def scan(lines: list[str]) -> tuple[list[tuple[int, str]], int]:
    """(줄번호, 샌 문장) 목록과 검사한 문장 수."""
    hits: list[tuple[int, str]] = []
    total = 0
    in_fence = False
    for no, raw in enumerate(lines, 1):
        if _FENCE.match(raw):
            in_fence = not in_fence
            continue
        if in_fence or not raw.strip() or _SKIP_LINE.match(raw):
            continue
        line = _LIST_MARK.sub("", raw).strip()
        total += sum(1 for s in _SENT_SPLIT.split(_QUOTED.sub(" ", line)) if s.strip())
        for s in leaky_sentences(line):
            hits.append((no, s))
    return hits, total


def main() -> int:
    ap = argparse.ArgumentParser(description="개조식 종결 검사")
    ap.add_argument("path", help="검사할 파일. `-` 면 표준 입력")
    ap.add_argument("--quiet", "-q", action="store_true", help="개수만 찍는다")
    args = ap.parse_args()

    if args.path == "-":
        text = sys.stdin.read()
    else:
        with open(args.path, encoding="utf-8") as f:
            text = f.read()

    hits, total = scan(text.splitlines())

    if not args.quiet:
        for no, s in hits:
            s = s if len(s) <= 100 else s[:97] + "…"
            print(f"{args.path}:{no}: {s}")
        if hits:
            print()

    pct = len(hits) / total * 100 if total else 0.0
    print(f"문장 {total} · 누출 {len(hits)} ({pct:.1f}%)")
    if hits:
        print("→ 걸린 줄의 **종결부만** 명사형으로 고쳐 달라고 요청할 것. 재작성이 아니다.")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
