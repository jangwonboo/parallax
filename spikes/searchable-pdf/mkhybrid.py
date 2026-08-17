"""하이브리드 텍스트 레이어 — 좌표는 Tesseract, 글자는 vlmparse.

왜 섞나. **어느 한쪽으로는 안 된다.**

- vlmparse(Datalab) 는 글자가 정확하다(하이픈 복원·수식 LaTeX·러닝헤드 제거).
  그런데 좌표를 **블록 단위로만** 준다. 문단을 한 줄로 흘려 주므로 인쇄된 줄바꿈을
  알 수 없어, 블록 사각형 안에 줄을 다시 흘리면 낱말이 표류한다
  (실측 p9: y 차이 중앙값 −19.6pt, 범위 −75~+55pt = 한 줄 24pt 기준 ±3줄).
- Tesseract 는 **낱말마다** 상자를 주지만 글자가 나쁘다(분철 하이픈을 남기고,
  수식을 뭉개고, 러닝헤드를 섞고, 장식 글자에서 잡음을 만든다).

그래서 상자는 Tesseract, 글자는 vlmparse 것으로 갈아 끼운다. 표준 OCR 레이어가
하는 일과 같다 — 다만 「무엇을 쓸 것인가」를 더 나은 판독기에서 가져온다.

맞추는 방법은 `difflib` 이다. 두 낱말 열을 정렬해 놓고

  equal    그대로
  replace  vlmparse 쪽 낱말을 Tesseract 상자에 나눠 담는다
           (`mech-` + `anics` → `mechanics` 하나. 남는 상자는 비운다)
  delete   Tesseract 에만 있는 것 = 잡음·러닝헤드 → 버린다
  insert   vlmparse 에만 있는 것 → 앞 상자 글에 붙인다(상자가 없으므로)
"""
import csv
import hashlib
import json
import re
import sys
from difflib import SequenceMatcher
from pathlib import Path

import fitz
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

SRC = "D:/ebook/__output__/quantum_mechanics_the_theoretical_minimum.pdf"
BASE = Path("D:/ebook/__output__/ocr-compare")
FONT = "C:/Windows/Fonts/seguisym.ttf"
TESS_DPI = 300
# (원본 쪽, vlmparse 작업폴더, tesseract tsv)
JOBS = ([(p, BASE / "vlm/work", BASE / f"tess/p{p:02d}.tsv") for p in range(1, 11)]
        + [(p, BASE / "vlm-math/work", BASE / f"tess-math/p{p}.tsv") for p in (37, 38, 39)])
SKIP = {"Figure", "Picture", "Table", "TableGroup", "Form", "PageHeader", "PageFooter"}
BS = chr(92)
FT = fitz.Font(fontfile=FONT)      # 글자 폭을 재는 데 쓴다

TEX_UNI = {
    "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε",
    "theta": "θ", "lambda": "λ", "mu": "μ", "nu": "ν", "pi": "π", "rho": "ρ",
    "sigma": "σ", "phi": "φ", "psi": "ψ", "omega": "ω", "Delta": "Δ",
    "Omega": "Ω", "Psi": "Ψ", "Phi": "Φ", "Sigma": "Σ", "langle": "⟨",
    "rangle": "⟩", "sum": "∑", "int": "∫", "sqrt": "√", "approx": "≈",
    "neq": "≠", "leq": "≤", "geq": "≥", "pm": "±", "times": "×", "cdot": "·",
    "infty": "∞", "partial": "∂", "hbar": "ℏ", "mathcal": "", "mathbf": "",
    "text": "", "left": "", "right": "", "frac": "/",
}


def ckey(payload, *salts):
    h = hashlib.sha1()
    h.update(payload.encode())
    for s in salts:
        h.update(b"\x00")
        h.update(str(s).encode())
    return h.hexdigest()[:20]


def block_text(chunk):
    t = re.sub(r"<[^>]+>", " ", chunk.get("html") or "")
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&#x27;", "'"), ("&quot;", '"'), ("&nbsp;", " ")):
        t = t.replace(a, b)
    if chunk.get("block_type") == "Equation":
        esc = re.escape(BS)
        t = re.sub(esc + r"(begin|end)\{[a-z*]*\}", " ", t)
        t = re.sub(esc * 2, " ", t)
        t = re.sub(esc + r"([a-zA-Z]+)",
                   lambda m: TEX_UNI.get(m.group(1), m.group(1)), t)
        for ch in "${}_^&":
            t = t.replace(ch, " ")
    return re.sub(r"\s+", " ", t).strip()


def tess_words(tsv):
    """[(글자, fitz.Rect)] — 300dpi 픽셀을 pt 로 옮겨 놓는다."""
    k = 72 / TESS_DPI
    out = []
    with open(tsv, encoding="utf-8") as f:
        for r in csv.DictReader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            txt = (r.get("text") or "").strip()
            if not txt or float(r.get("conf") or -1) < 30:
                continue
            x, y = float(r["left"]) * k, float(r["top"]) * k
            out.append((txt, fitz.Rect(x, y, x + float(r["width"]) * k,
                                       y + float(r["height"]) * k)))
    return out


def norm(w):
    return re.sub(r"[^a-z0-9α-ω]", "", w.lower())


def assign(tess, want):
    """Tesseract 상자 열에 vlmparse 낱말을 배정한다. [(글자, Rect)]."""
    a = [norm(w) for w, _ in tess]
    b = [norm(w) for w in want]
    out = [None] * len(tess)
    for op, i1, i2, j1, j2 in SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if op == "equal":
            for n, j in enumerate(range(j1, j2)):
                out[i1 + n] = want[j]
        elif op == "replace":
            src = want[j1:j2]
            # 상자가 더 많으면 앞쪽부터 채우고 나머지는 비운다(하이픈 병합이 이 경우다)
            for n in range(i2 - i1):
                out[i1 + n] = src[n] if n < len(src) else None
            # 낱말이 더 많으면 남은 것을 마지막 상자에 몰아 넣는다
            if len(src) > (i2 - i1) and i2 > i1:
                tail = " ".join(src[i2 - i1:])
                out[i2 - 1] = (out[i2 - 1] + " " + tail) if out[i2 - 1] else tail
        elif op == "insert":
            k = i1 - 1
            if k >= 0:
                add = " ".join(want[j1:j2])
                out[k] = (out[k] + " " + add) if out[k] else add
        # delete: Tesseract 에만 있는 잡음 → None 으로 남긴다
    return [(t, r) for t, (_, r) in zip(out, tess) if t]


def put(page, text, rect, visible):
    """상자 폭에 맞춰 글자 크기를 골라 한 낱말을 앉힌다."""
    # `get_text_length` 는 내장 폰트 이름만 안다. 임베드한 TTF 는 Font 로 재야 한다.
    w = FT.text_length(text, fontsize=10)
    # **폭에만 맞추면 글리프 상자가 위로 부푼다.** 짧은 낱말이 넓은 상자에 들어가면
    # 글자 크기가 터무니없이 커지고, 강조 상자가 실제 글자보다 훨씬 높아진다
    # (실측: 그 탓에 상자 위끝이 13pt 위로 솟았다). 높이로도 눌러 준다.
    by_w = (rect.width / w) * 10 if w else 8.0
    by_h = rect.height * 1.05                 # 글자 크기 ≈ 잉크 높이
    size = max(2.0, min(60.0, by_w, by_h))
    page.insert_text(fitz.Point(rect.x0, rect.y1 - rect.height * 0.2),
                     text, fontsize=size, fontname="ocr", fontfile=FONT,
                     render_mode=0 if visible else 3,
                     color=(0, .55, 0) if visible else (0, 0, 0))


pages = [p for p, _, _ in JOBS]
src = fitz.open(SRC)
sub = fitz.open()
for p in pages:
    sub.insert_pdf(src, from_page=p - 1, to_page=p - 1)
where = {p: i for i, p in enumerate(pages)}


def build(visible, out):
    doc = fitz.open()
    doc.insert_pdf(sub)
    st = dict(words=0, dropped=0, blocks=0)
    for pno, work, tsv in JOBS:
        f = work / ".vlmparse-cache" / "read" / f"{ckey(f'datalab:{pno}','accurate',200,2200,'jpg')}.json"
        if not f.exists() or not Path(tsv).exists():
            continue
        chunks = json.loads(f.read_text(encoding="utf-8"))["chunks"]
        iw, ih = Image.open(work / "pages" / f"p{pno:04d}.jpg").size
        page = doc[where[pno]]
        kx, ky = page.rect.width / iw, page.rect.height / ih
        words = tess_words(tsv)
        used = set()
        for c in chunks:
            bb = c.get("bbox")
            if not bb or c.get("block_type") in SKIP:
                continue
            txt = block_text(c)
            if not txt:
                continue
            r = fitz.Rect(bb[0] * kx, bb[1] * ky, bb[2] * kx, bb[3] * ky)
            if visible:
                page.draw_rect(r, color=(0, .4, 1), width=1.0)
            # 이 블록 사각형 안에 중심이 든 Tesseract 낱말만 쓴다
            inside = [(i, w) for i, w in enumerate(words)
                      if i not in used and r.contains(
                          fitz.Point((w[1].x0 + w[1].x1) / 2, (w[1].y0 + w[1].y1) / 2))]
            if not inside:
                st["dropped"] += 1
                continue
            used.update(i for i, _ in inside)
            for text, rect in assign([w for _, w in inside], txt.split()):
                put(page, text, rect, visible)
                st["words"] += 1
            st["blocks"] += 1
    doc.save(out, garbage=3, deflate=True)
    doc.close()
    return st


print("하이브리드 투명판", build(False, BASE / "qm_hybrid.pdf"))
print("하이브리드 대조판", build(True, BASE / "qm_hybrid_debug.pdf"))
src.close()
sub.close()
