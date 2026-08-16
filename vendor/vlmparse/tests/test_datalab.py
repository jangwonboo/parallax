"""API 없이 도는 시험. 여기 있는 것은 전부 **실전에서 한 번씩 틀렸던 자리**다."""
import hashlib

import pytest

from vlmparse.backends import datalab as dl
from vlmparse.render import parse_pages
from vlmparse.schema import Document


# ── 수식 ────────────────────────────────────────────────
def test_inline_math_keeps_delimiters():
    """<math> 를 그냥 걷으면 LaTeX 가 산문에 맨몸으로 박힌다.

    실측: 양자역학 책 본문에 `\\Delta e \\times \\Delta d` 가 그대로 들어가
    번역기가 글로 보고 고쳐 버렸다.
    """
    html = "<p>the product <math>\\Delta e \\times \\Delta d</math> is bounded</p>"
    assert dl.html_to_text(html) == "the product $\\Delta e \\times \\Delta d$ is bounded"


def test_inline_math_unescapes_entities():
    html = "<p>if <math>a &lt; b</math> then</p>"
    assert dl.html_to_text(html) == "if $a < b$ then"


def test_equation_block_becomes_display_math():
    html = '<math display="block">E = mc^2</math>'
    assert dl.equation_text(html) == "$$E = mc^2$$"


def test_equation_without_math_tag_is_still_latex():
    assert dl.equation_text("<p>x^2 + y^2 = z^2</p>") == "$$x^2 + y^2 = z^2$$"


def test_plain_text_untouched_by_math_rule():
    assert dl.html_to_text("<p>no math <b>here</b></p>") == "no math here"


# ── 유형 대응 ────────────────────────────────────────────
def test_equation_and_inline_math_types():
    chunks = [
        {"block_type": "Equation", "html": "<math>E = mc^2</math>"},
        {"block_type": "TextInlineMath", "html": "<p>where <math>c</math> is light</p>"},
        {"block_type": "SectionHeader", "html": "<h2>Chapter 1</h2>"},
        {"block_type": "Table", "html": "<table><tr><td>a</td></tr></table>"},
        {"block_type": "PageNumber", "html": "<p>42</p>"},
    ]
    items, _ = dl.chunks_to_blocks(chunks)
    assert [i["type"] for i in items] == ["equation", "p", "h2", "table_raw"]
    assert items[0]["text"] == "$$E = mc^2$$"
    assert items[1]["text"] == "where $c$ is light"
    # 표는 태그를 보존한다 — 구조가 곧 내용이다
    assert "<td>" in items[3]["text"]


def test_dropped_types_are_dropped():
    chunks = [{"block_type": t, "html": "<p>x</p>"}
              for t in ("PageHeader", "PageFooter", "PageNumber", "Picture", "Figure")]
    items, _ = dl.chunks_to_blocks(chunks)
    assert items == []


def test_unknown_type_folds_to_paragraph():
    items, _ = dl.chunks_to_blocks([{"block_type": "Handwriting", "html": "<p>hi</p>"}])
    assert items == [{"type": "p", "text": "hi"}]


# ── 과금 ────────────────────────────────────────────────
def test_cost_is_cents_not_dollars():
    """total_cost 를 달러로 읽어 5쪽 시험이 $5.00 으로 찍힌 적이 있다 — 실제 5¢."""
    s = dl.Spend()
    s.record({"total_cost": 1})
    assert s.usd == pytest.approx(0.01)
    assert s.pages == 1


def test_cost_prefers_explicit_cents_field():
    s = dl.Spend()
    s.record({"total_cost": 1, "cost_breakdown": {"final_cost_cents": 2.5}})
    assert s.usd == pytest.approx(0.025)


def test_cost_ignores_garbage():
    s = dl.Spend()
    s.record({"total_cost": None})
    s.record({"total_cost": "x"})
    assert s.usd == 0.0


# ── 그림 ────────────────────────────────────────────────
PNG_1x1 = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
           "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def test_asset_id_is_content_hash_not_filename():
    """Datalab 파일명은 레이아웃 기반이라 서로 다른 그림이 같은 이름으로 온다 —
    244쪽 실측에서 한 이름에 다른 그림 16장이 왔다."""
    import base64
    data = base64.b64decode(PNG_1x1)
    want = hashlib.sha1(data).hexdigest()[:16]
    got = dl.harvest_images({"html": "", "images": {"_page_0_Picture_1.png": PNG_1x1}})
    # 1x1 은 MIN_FIGURE_PX 미만이라 fitz 가 있으면 걸러진다. 걸러지지 않았다면
    # id 는 반드시 내용 해시여야 한다.
    for aid, _ in got:
        assert aid == want


def test_harvest_reads_images_from_any_block_type():
    """표지 그림이 SectionHeader 안에 <img> 로 내장되어 온 실측이 있다."""
    chunk = {"block_type": "SectionHeader", "html": "<h1>T</h1>", "images": {}}
    assert dl.harvest_images(chunk) == []


# ── 쪽 지정 ──────────────────────────────────────────────
@pytest.mark.parametrize("spec,total,want", [
    (None, 3, [1, 2, 3]),
    ("2", 5, [2]),
    ("1-3", 5, [1, 2, 3]),
    ("1-2,4", 5, [1, 2, 4]),
    ("1-9999", 3, [1, 2, 3]),      # 전권을 뜻하는 흔한 표기
    ("0-2", 3, [1, 2]),            # 범위 밖은 조용히 버린다
    ("2,2,1", 3, [2, 1]),          # 중복 제거, 쓴 순서 유지
])
def test_parse_pages(spec, total, want):
    assert parse_pages(spec, total) == want


# ── 스키마 왕복 ───────────────────────────────────────────
def test_document_roundtrip():
    d = Document.from_dict({
        "source": "b.pdf", "backend": "datalab",
        "pages": [{"page": 1, "blocks": [{"type": "equation", "text": "$$x$$"}],
                   "error": None},
                  {"page": 2, "blocks": [], "error": "boom"}],
        "assets": {"a1": {"mime": "image/png", "w": 10, "h": 10, "alt": "", "b64": "x"}},
        "cost": {"pages": 2, "usd": 0.02},
    })
    assert [b.type for b in d.blocks] == ["equation"]
    assert d.failed_pages == [2]
    assert Document.from_dict(d.to_dict()).to_dict() == d.to_dict()


def test_unknown_block_type_rejected():
    with pytest.raises(ValueError):
        Document.from_dict({"source": "x", "backend": "y",
                            "pages": [{"page": 1, "blocks": [{"type": "nope", "text": ""}]}]})


# ── 표를 그림으로 ────────────────────────────────────────
def _page_png(tmp_path, w=1485, h=2200):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(im)
    d.rectangle([160, 240, 1390, 1250], outline="black", width=3)
    d.text((300, 600), "TABLE", fill="black")
    f = tmp_path / "p0050.jpg"
    im.save(f)
    return f


def test_table_becomes_figure_when_page_image_given(tmp_path):
    """표는 쪽에서 오려 figure 로 나가고 HTML 은 alt 에 남는다."""
    img = _page_png(tmp_path)
    chunks = [{"block_type": "Table", "html": "<table><tr><td>a</td></tr></table>",
               "bbox": [166.0, 244.0, 1384.0, 1240.0]}]
    items, assets = dl.chunks_to_blocks(chunks, page_image=img)
    assert [i["type"] for i in items] == ["figure"]
    aid = items[0]["text"]
    assert aid in assets
    a = assets[aid]
    assert a["mime"] == "image/png"
    assert a["w"] > 1000 and a["h"] > 900
    # 글을 잃지 않는다 — 검색·나중의 셀 번역이 여기서 되살아난다
    assert "<table>" in a["alt"]


def test_table_falls_back_to_html_without_page_image():
    chunks = [{"block_type": "Table", "html": "<table><tr><td>a</td></tr></table>",
               "bbox": [166.0, 244.0, 1384.0, 1240.0]}]
    items, assets = dl.chunks_to_blocks(chunks)          # 쪽 이미지 없음
    assert [i["type"] for i in items] == ["table_raw"]
    assert assets == {}


def test_tables_html_mode_keeps_markup(tmp_path):
    img = _page_png(tmp_path)
    chunks = [{"block_type": "Table", "html": "<table><tr><td>a</td></tr></table>",
               "bbox": [166.0, 244.0, 1384.0, 1240.0]}]
    items, _ = dl.chunks_to_blocks(chunks, page_image=img, tables="html")
    assert items[0]["type"] == "table_raw"


def test_table_like_types_also_cropped(tmp_path):
    """TableGroup·Form 도 표에 준한다."""
    img = _page_png(tmp_path)
    for bt in ("TableGroup", "Form"):
        items, _ = dl.chunks_to_blocks(
            [{"block_type": bt, "html": "<table><tr><td>x</td></tr></table>",
              "bbox": [166.0, 244.0, 1384.0, 1240.0]}], page_image=img)
        assert [i["type"] for i in items] == ["figure"], bt


def test_bbox_missing_falls_back(tmp_path):
    img = _page_png(tmp_path)
    items, _ = dl.chunks_to_blocks(
        [{"block_type": "Table", "html": "<table><tr><td>a</td></tr></table>"}],
        page_image=img)
    assert items[0]["type"] == "table_raw"


def test_tiny_region_not_cropped(tmp_path):
    """오려 낸 것이 너무 작으면 그림이 아니다 — 글로 남긴다."""
    img = _page_png(tmp_path)
    items, _ = dl.chunks_to_blocks(
        [{"block_type": "Table", "html": "<table><tr><td>a</td></tr></table>",
          "bbox": [10.0, 10.0, 40.0, 40.0]}], page_image=img)
    assert items[0]["type"] == "table_raw"
