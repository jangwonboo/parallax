"""vlmparse 캐시(chunks + bbox) → 원본 PDF 에 투명 텍스트 레이어. 시연용.

앞 10쪽 + 수식 3쪽(p37~39)만 뽑아 두 파일을 만든다.

  qm_searchable_test.pdf  실제 물건 — 글자가 안 보이고 검색·복사만 된다
  qm_layer_debug.pdf      눈으로 대조용 — 넣은 글자를 붉게 보이고 블록 테두리를 그린다
"""
import json
import hashlib
import re
import sys
from pathlib import Path

import fitz
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

SRC = "D:/ebook/__output__/quantum_mechanics_the_theoretical_minimum.pdf"
BASE = Path("D:/ebook/__output__/ocr-compare")
FONT = "C:/Windows/Fonts/seguisym.ttf"        # 줄표·둥근인용부호·그리스·⟨⟩ 를 덮는다
JOBS = [(range(1, 11), BASE / "vlm/work"), (range(37, 40), BASE / "vlm-math/work")]
# 그림·표는 글이 없고, 머리글·꼬리글은 검색에 잡히면 잡음이다
SKIP = {"Figure", "Picture", "Table", "TableGroup", "Form", "PageHeader", "PageFooter"}

BS = chr(92)


def ckey(payload, *salts):
    """vlmparse.cache.Cache.key 와 같은 방식으로 캐시 열쇠를 만든다."""
    h = hashlib.sha1()
    h.update(payload.encode())
    for s in salts:
        h.update(b"\x00")
        h.update(str(s).encode())
    return h.hexdigest()[:20]


def plain(chunk):
    """검색에 쓸 글. 수식은 LaTeX 뼈대를 걷어 낱말만 남긴다."""
    t = re.sub(r"<[^>]+>", " ", chunk.get("html") or "")
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&#x27;", "'"), ("&quot;", '"'), ("&nbsp;", " ")):
        t = t.replace(a, b)
    if chunk.get("block_type") == "Equation":
        t = latex_to_plain(t)
    return re.sub(r"\s+", " ", t).strip()


# 흔한 것만 유니코드로 옮긴다. 남겨 두면 검색 레이어에 `alpha_1 \\ rangle` 같은
# 잡음이 박혀 낱말 검색이 더러워진다. 전부 옮기는 것은 이 도구의 몫이 아니다.
TEX_UNI = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "theta": "θ", "lambda": "λ", "mu": "μ", "nu": "ν", "pi": "π", "rho": "ρ",
    "sigma": "σ", "phi": "φ", "psi": "ψ", "omega": "ω", "Delta": "Δ",
    "Omega": "Ω", "Psi": "Ψ", "Phi": "Φ", "Sigma": "Σ",
    "langle": "⟨", "rangle": "⟩", "sum": "∑", "int": "∫", "sqrt": "√",
    "approx": "≈", "neq": "≠", "leq": "≤", "geq": "≥", "pm": "±",
    "times": "×", "cdot": "·", "infty": "∞", "partial": "∂", "hbar": "ℏ",
    "rightarrow": "→", "leftarrow": "←", "mathcal": "", "mathbf": "",
    "text": "", "left": "", "right": "", "frac": "/",
}


def latex_to_plain(t):
    """수식 LaTeX → 검색에 쓸 만한 평문."""
    esc = re.escape(BS)
    t = re.sub(esc + r"(begin|end)\{[a-z*]*\}", " ", t)     # 행렬 환경
    t = re.sub(esc * 2, " ", t)                             # 행 구분 \\
    t = re.sub(esc + r"([a-zA-Z]+)",
               lambda m: TEX_UNI.get(m.group(1), m.group(1)), t)
    for ch in "${}_^&":
        t = t.replace(ch, " ")
    return t


pages = [p for rng, _ in JOBS for p in rng]
src = fitz.open(SRC)
sub = fitz.open()
for p in pages:
    sub.insert_pdf(src, from_page=p - 1, to_page=p - 1)
where = {p: i for i, p in enumerate(pages)}            # 원본 쪽 → 뽑은 문서의 인덱스


def build(visible, out):
    doc = fitz.open()
    doc.insert_pdf(sub)
    st = dict(blocks=0, chars=0, failed=0, skipped=0, missing=0)
    for rng, work in JOBS:
        for pno in rng:
            k = ckey(f"datalab:{pno}", "accurate", 200, 2200, "jpg")
            f = work / ".vlmparse-cache" / "read" / f"{k}.json"
            if not f.exists():
                st["missing"] += 1
                continue
            chunks = json.loads(f.read_text(encoding="utf-8"))["chunks"]
            iw, ih = Image.open(work / "pages" / f"p{pno:04d}.jpg").size
            page = doc[where[pno]]
            kx, ky = page.rect.width / iw, page.rect.height / ih
            for c in chunks:
                bb, txt = c.get("bbox"), plain(c)
                if not bb or not txt:
                    continue
                if c.get("block_type") in SKIP:
                    st["skipped"] += 1
                    continue
                r = fitz.Rect(bb[0] * kx, bb[1] * ky, bb[2] * kx, bb[3] * ky)
                if visible:
                    page.draw_rect(r, color=(0, .4, 1), width=1.2)
                # 상자를 넘치지 않을 때까지 글자를 줄인다. 넘치면 insert_textbox 가
                # 음수를 돌려주고 **아무것도 넣지 않는다** — 조용한 누락이 된다.
                guess = max(6.0, min(48.0,
                            r.height / max(1, round(len(txt) * 6.5 / max(r.width, 1)))))
                ok = -1
                for s in (guess, guess * .85, guess * .7, guess * .55, 9, 7, 5, 4):
                    ok = page.insert_textbox(
                        r, txt, fontsize=s, fontname="ocr", fontfile=FONT,
                        render_mode=0 if visible else 3,
                        color=(.85, 0, 0) if visible else (0, 0, 0))
                    if ok >= 0:
                        break
                if ok < 0:
                    st["failed"] += 1
                else:
                    st["blocks"] += 1
                    st["chars"] += len(txt)
    doc.save(out, garbage=3, deflate=True)
    doc.close()
    return st


print("투명판", build(False, BASE / "qm_searchable_test.pdf"))
print("대조판", build(True, BASE / "qm_layer_debug.pdf"))
src.close()
sub.close()
