"""Datalab API 백엔드 (https://www.datalab.to).

Marker 를 호스팅한 서비스다. 쪽 이미지를 보내면 **유형이 붙은 chunks** 를 돌려준다.
markdown 으로 받으면 안 된다 — 유형이 없어 표지 그림 설명문이 h1·본문으로 새어
들어온다(실측). chunks 는 블록마다 `block_type` 이 붙어 와서 추측 없이 대응만 하면 된다.

여기 담긴 재시도·과금·그림 규칙은 전부 **책 네 권을 태우며 얻은 것**이다. 새로
짜면 같은 자리를 다시 밟는다 — 아래 주석이 그 기록이다.
"""
from __future__ import annotations

import base64
import hashlib
import io
import os
import re
import threading
import time
from html import unescape
from pathlib import Path

URL = "https://www.datalab.to/api/v1/convert"
PLACEHOLDER = "your-datalab-api-key-here"
MODES = ("fast", "balanced", "accurate")

#: 이보다 작은 그림은 장식 조각(불릿·괘선)으로 보고 버린다.
MIN_FIGURE_PX = 64

# 표에 준하는 유형. **그림으로 오려 낸다**(`tables="image"`, 기본).
#
# HTML 재구성은 잘 되지만 편집된 표의 조판(열 폭·굵기·괘선의 뜻)까지는 살리지
# 못한다. 원본을 오려 내면 보이는 것은 원서 그대로다. 대신 글자를 잃으므로
# **HTML 을 asset.alt 에 함께 넣어** 검색·나중의 셀 단위 번역 여지를 남긴다.
TABLE_LIKE = {"Table", "TableGroup", "Form"}

#: 오려 낼 때의 여유(px). 괘선이 잘리지 않을 만큼만 — 넉넉히 주면 아래 각주가
#: 딸려 온다(실측: PAD 10 에서 50쪽 표에 각주 한 줄이 붙었다).
CROP_PAD = 5

# 유형째로 버리는 것: 쪽 표시(러닝 헤더·쪽 번호)와 그림의 *텍스트*. 모델이 그림에
# 지어 붙인 설명문은 판독이 아니라 묘사라 본문이 아니다 — 그림 데이터 자체는
# harvest_images() 가 asset 으로 줍고 alt 로만 보관한다.
DROP = {"PageHeader", "PageFooter", "PageNumber", "Picture", "Figure"}

# 유형 대응. 여기 없는 것은 p 로 접는다.
TYPE = {
    "Caption": "figcaption",
    "Footnote": "footnote",
    "Table": "table_raw",
    "TableGroup": "table_raw",
    "Form": "table_raw",
    "Equation": "equation",
    # TextInlineMath 는 「인라인 수식이 든 단락」이다 — 단락이므로 p 로 두되
    # 아래 html_to_text 가 <math> 를 $…$ 로 살린다.
    "TextInlineMath": "p",
}

HTML_TAG_RE = re.compile(r"</?[a-zA-Z][^>]*>")
H_TAG_RE = re.compile(r"<h([1-6])")
IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.I)
# marker 의 html/chunks 출력은 수식을 <math> 로 감싸고 **안에 LaTeX** 를 넣는다
# (MathML 이 아니다). 태그만 걷으면 구분자가 사라져 본문에 `\Delta e \times \Delta d`
# 같은 것이 맨몸으로 박힌다 — 하류는 그것이 수식인지 알 길이 없고, 번역기가
# 글로 보고 고쳐 버린다.
MATH_RE = re.compile(r"<math\b[^>]*>(.*?)</math>", re.I | re.S)


class DatalabError(RuntimeError):
    pass


def find_key(explicit: str | None = None) -> str | None:
    """환경변수 → .env(현재 폴더부터 위로) 순. 자리표시자는 없는 것으로 친다."""
    if explicit and explicit != PLACEHOLDER:
        return explicit
    key = os.environ.get("DATALAB_API_KEY", "").strip()
    if not key:
        seen: list[Path] = []
        env_file = os.environ.get("VLMPARSE_ENV_FILE")
        if env_file:
            seen.append(Path(env_file))
        here = Path.cwd()
        seen += [here / ".env", *[p / ".env" for p in here.parents]]
        for env in seen:
            if not env.is_file():
                continue
            for line in env.read_text(encoding="utf-8").splitlines():
                m = re.match(r"\s*DATALAB_API_KEY\s*=\s*(.+?)\s*$", line)
                if m:
                    key = m.group(1).strip().strip('"').strip("'")
                    break
            if key:
                break
    return key if key and key != PLACEHOLDER else None


# ── 과금 ────────────────────────────────────────────────
# **단위는 센트다.** 응답이 `total_cost: 1` 과 `cost_breakdown.final_cost_cents: 1.0`
# 을 함께 준다(2026-08-08 실측). 전에 total_cost 를 달러로 읽어 5쪽 시험이
# 「$5.00」으로 찍혔다 — 실제 5¢ 의 100배다. 이 값은 「전 쪽을 태울지」 정하는
# 근거라 틀리면 작업을 접게 만든다.
class Spend:
    def __init__(self) -> None:
        self.pages = 0
        self.usd = 0.0
        self._lock = threading.Lock()

    def record(self, status: dict) -> None:
        cents = (status.get("cost_breakdown") or {}).get("final_cost_cents")
        if cents is None:
            cents = status.get("total_cost")
        try:
            c = float(cents or 0)
        except (TypeError, ValueError):
            return
        with self._lock:
            self.pages += 1
            self.usd += c / 100.0


# ── 판독 ────────────────────────────────────────────────
def read_page(img: Path, key: str, mode: str = "accurate",
              spend: Spend | None = None, timeout_s: int = 300) -> list[dict]:
    """쪽 이미지 하나 → chunks. 완료까지 폴링한다."""
    import httpx

    mime = "image/png" if img.suffix.lower() == ".png" else "image/jpeg"
    with httpx.Client(timeout=60) as cl:
        # 429 는 실패가 아니라 **순서 대기**다. 여기서 물러나지 않으면 책 한 권의
        # 대부분이 「판독 실패」로 남는다(244쪽 중 219쪽이 그렇게 죽었다).
        #
        # 전송 오류도 같이 물러난다. 상태 코드만 보면 연결이 끊긴 경우
        # (`Server disconnected without sending a response`)가 그대로 실패로
        # 떨어진다 — 175쪽 책에서 8쪽이 그렇게 빈 쪽으로 남았다. **빈 쪽은
        # 조용하다**: 일치율은 100% 로 찍히고 블록만 없다.
        for attempt in range(8):
            try:
                r = cl.post(URL, headers={"X-API-Key": key},
                            files={"file": (img.name, img.read_bytes(), mime)},
                            data={"output_format": "chunks", "mode": mode})
            except httpx.TransportError:
                if attempt == 7:
                    raise
                time.sleep(min(60, 5 * 2 ** attempt))
                continue
            if r.status_code != 429:
                break
            time.sleep(float(r.headers.get("Retry-After") or min(60, 5 * 2 ** attempt)))
        r.raise_for_status()
        j = r.json()
        if not j.get("success", True):
            raise DatalabError(j.get("error") or str(j))

        check = j["request_check_url"]
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            time.sleep(2)
            try:
                p = cl.get(check, headers={"X-API-Key": key})
            except httpx.TransportError:
                continue                      # 폴링은 마감까지 계속 두드린다
            if p.status_code == 429:
                time.sleep(float(p.headers.get("Retry-After") or 5))
                continue
            s = p.json()
            st = s.get("status")
            if st == "complete":
                if s.get("success") is False:
                    raise DatalabError(s.get("error") or "failed")
                if spend is not None:
                    spend.record(s)
                ch = s.get("chunks") or []
                return ch.get("blocks") or [] if isinstance(ch, dict) else ch
            if st == "failed":
                raise DatalabError(s.get("error") or "failed")
        raise DatalabError(f"poll timeout ({timeout_s}s)")


# ── chunks → 블록 ───────────────────────────────────────
def html_to_text(html: str) -> str:
    """태그·강조 장식을 걷어 본문만 남긴다. **수식은 살린다.**

    `<math>LATEX</math>` 를 `$LATEX$` 로 바꾼 **뒤에** 나머지 태그를 걷는다.
    순서가 뒤바뀌면 구분자가 사라져 LaTeX 가 산문에 섞인다.
    """
    def keep_math(m: re.Match) -> str:
        body = HTML_TAG_RE.sub("", m.group(1))        # <math> 안의 잔여 태그
        body = unescape(body).strip()
        return f"${body}$" if body else ""

    text = MATH_RE.sub(keep_math, html)
    text = HTML_TAG_RE.sub(" ", text)
    text = text.replace("**", "")
    return re.sub(r"[^\S\n]+", " ", text).strip()


def equation_text(html: str) -> str:
    """별행 수식 → `$$…$$`. 안에 <math> 가 없으면 통째로 LaTeX 로 본다."""
    bodies = [unescape(HTML_TAG_RE.sub("", b)).strip() for b in MATH_RE.findall(html)]
    body = " ".join(b for b in bodies if b) or unescape(HTML_TAG_RE.sub("", html)).strip()
    body = re.sub(r"\s+", " ", body)
    return f"$${body}$$" if body else ""


def harvest_images(chunk: dict, page_w: int = 0) -> list[tuple[str, dict]]:
    """청크에 실려 온 그림을 (asset id, asset) 로 줍는다.

    Picture 블록만 보면 안 된다 — 실측에서 표지 그림이 SectionHeader 안에
    <img> 로 내장되어 왔다. 유형과 무관하게 images 필드를 다 줍는다.
    """
    try:
        import fitz
    except ImportError:                                    # pragma: no cover
        fitz = None                                        # 크기를 못 재면 다 받는다

    out: list[tuple[str, dict]] = []
    html = chunk.get("html") or ""
    for fname, b64 in (chunk.get("images") or {}).items():
        try:
            data = base64.b64decode(b64)
        except Exception:
            continue
        w = h = 0
        if fitz is not None:
            try:
                pix = fitz.Pixmap(data)
                w, h = pix.width, pix.height
            except Exception:
                continue                                   # 못 읽으면 그림이 아니다
            if min(w, h) < MIN_FIGURE_PX:
                continue
        alt = ""
        for m in IMG_TAG_RE.finditer(html):
            if fname in m.group(0):
                am = re.search(r'alt="([^"]*)"', m.group(0))
                alt = unescape(am.group(1)) if am else ""
                break
        # **id 는 내용 sha1 이다.** Datalab 의 파일명은 내용 해시가 아니라 레이아웃
        # 기반이라 서로 다른 그림이 같은 이름으로 온다 — 244쪽 실측에서 한 이름에
        # 다른 그림 16장이 왔고, 파일명을 id 로 쓰면 덮어써져 그림이 뒤바뀐다.
        aid = hashlib.sha1(data).hexdigest()[:16]
        mime = "image/jpeg" if data[:3] == b"\xff\xd8\xff" else "image/png"
        # 쪽 폭 대비 비율. 판독기가 준 그림에도 bbox 가 오므로 거기서 잰다 —
        # 없으면 0(모름)이고 리더는 상한만 건다.
        bb = chunk.get("bbox")
        wfrac = round((float(bb[2]) - float(bb[0])) / page_w, 4) if bb and page_w else 0.0
        out.append((aid, {"mime": mime, "w": w, "h": h, "alt": alt,
                          "wfrac": wfrac, "b64": b64}))
    return out


def crop_region(page_image: Path, bbox: list[float], alt: str = "",
                pad: int = CROP_PAD) -> tuple[str, dict] | None:
    """쪽 이미지에서 bbox 만큼 오려 asset 으로. (asset id, asset) 또는 None.

    **bbox 는 우리가 보낸 쪽 이미지와 같은 좌표계다**(실측: 쪽 1485×2200 에
    bbox 최대 1384×1240). 그래서 배율 환산이 필요 없다 — 판독기에 보낸 그
    이미지를 그대로 자르면 된다.
    """
    try:
        from PIL import Image
    except ImportError:                                    # pragma: no cover
        return None
    try:
        im = Image.open(page_image)
    except Exception:
        return None
    x0, y0, x1, y1 = (float(v) for v in bbox)
    box = (max(0, int(x0) - pad), max(0, int(y0) - pad),
           min(im.width, int(x1) + pad), min(im.height, int(y1) + pad))
    if box[2] - box[0] < MIN_FIGURE_PX or box[3] - box[1] < MIN_FIGURE_PX:
        return None
    # 쪽 폭 대비 비율을 함께 싣는다 — 리더가 원본에서 차지하던 만큼 그린다.
    wfrac = round((box[2] - box[0]) / im.width, 4)
    crop = im.crop(box).convert("RGB")
    buf = io.BytesIO()
    crop.save(buf, "PNG", optimize=True)                   # 표는 글자다 — 무손실로
    data = buf.getvalue()
    aid = hashlib.sha1(data).hexdigest()[:16]
    return aid, {"mime": "image/png", "w": crop.width, "h": crop.height, "wfrac": wfrac,
                 # 보이는 것은 그림이지만 글은 여기 남는다 — 검색과 나중의
                 # 셀 단위 번역이 이 자리에서 되살아난다.
                 "alt": alt, "b64": base64.b64encode(data).decode()}


def chunks_to_blocks(chunks: list[dict], page_image: Path | None = None,
                     tables: str = "image") -> tuple[list[dict], dict]:
    """chunks → ([{type,text}], {asset_id: asset}). 유형이 있으니 대응만 한다.

    `tables="image"`(기본)면 표를 쪽 이미지에서 오려 `figure` 블록으로 낸다 —
    쪽 이미지가 없으면 조용히 `table_raw`(HTML)로 물러난다.
    `tables="html"` 이면 늘 `table_raw` 다.
    """
    items: list[dict] = []
    assets: dict[str, dict] = {}
    page_w = 0
    if page_image:
        try:
            from PIL import Image
            page_w = Image.open(page_image).width
        except Exception:
            page_w = 0
    for c in chunks:
        bt = c.get("block_type") or ""
        for aid, asset in harvest_images(c, page_w):
            assets[aid] = asset
            items.append({"type": "figure", "text": aid})
        if bt in DROP:
            continue
        html = c.get("html") or ""

        if bt in TABLE_LIKE and tables == "image" and page_image and c.get("bbox"):
            got = crop_region(page_image, c["bbox"], alt=html)
            if got:
                aid, asset = got
                assets[aid] = asset
                items.append({"type": "figure", "text": aid})
                continue
            # 오려내기에 실패하면 글이라도 남긴다 — 아래 table_raw 로 떨어진다

        if bt in TABLE_LIKE:
            # 표는 구조가 곧 내용이다 — 태그를 걷으면 셀 경계가 사라진다
            text = re.sub(r"\s+", " ", html).strip()
        elif bt == "Equation":
            text = equation_text(html)
        else:
            text = html_to_text(html)
        if not text:
            continue
        if bt == "SectionHeader":
            m = H_TAG_RE.search(html)
            level = min(int(m.group(1)), 3) if m else 2
            items.append({"type": f"h{level}", "text": text})
        else:
            items.append({"type": TYPE.get(bt, "p"), "text": text})
    return items, assets
