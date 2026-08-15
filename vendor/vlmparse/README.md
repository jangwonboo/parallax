# vlmparse

PDF 를 VLM OCR 로 읽어 **구조 있는 블록**으로 뽑는다. 수식·표·그림을 지우지 않는다.

```bash
pip install vlmparse
export DATALAB_API_KEY=...            # https://www.datalab.to 에서 발급

vlmparse read book.pdf --pages 1-20 --out book.json
vlmparse read book.pdf --out book.md            # 바로 Markdown 으로
vlmparse md book.json                           # 뽑아 둔 것을 나중에 변환
```

```python
from vlmparse import read_pdf

doc = read_pdf("book.pdf", pages="1-20")
for b in doc.blocks:
    print(b.type, b.text[:60])
print(doc.cost.usd, doc.failed_pages)
```

## 왜 또 하나인가

PDF → 텍스트 도구는 많다. 이것이 지키려는 것은 셋이다.

**수식을 평문으로 뭉개지 않는다.** 판독기는 수식을 `<math>` 안의 LaTeX 로 준다.
태그를 그냥 걷으면 `\Delta e \times \Delta d` 가 산문 한가운데 맨몸으로 박힌다 —
구분자가 없으면 하류는 그것이 수식인지 알 수 없고, 번역기는 글로 보고 고쳐
버린다. 여기서는 인라인이 `$…$`, 별행이 `$$…$$` 로 남는다.

**한 쪽이 실패해도 조용하지 않다.** 빈 쪽은 티가 안 난다 — 일치율은 100% 로
찍히고 블록만 없다. 실패한 쪽은 `Page.error` 에 남고 CLI 가 목록을 크게 찍는다.

**재실행이 싸다.** 쪽마다 돈이 나가므로 캐시가 편의가 아니라 안전장치다.
244쪽 책이 219쪽에서 죽어도 다시 돌리면 완료분을 공짜로 건너뛴다.

## 출력

```json
{
  "schema_version": 1,
  "source": "book.pdf",
  "backend": "datalab",
  "pages": [
    { "page": 1,
      "blocks": [
        { "type": "h2",       "text": "The Uncertainty Principle" },
        { "type": "p",        "text": "the product $\\Delta e \\times \\Delta d$ is bounded" },
        { "type": "equation", "text": "$$E = mc^2$$" },
        { "type": "figure",   "text": "3f1a9c2b5d7e4088" }
      ],
      "error": null }
  ],
  "assets": { "3f1a9c2b5d7e4088": { "mime": "image/png", "w": 820, "h": 610, "alt": "…", "b64": "…" } },
  "cost": { "pages": 20, "usd": 0.2 }
}
```

블록 유형은 여덟이다 — `h1` `h2` `h3` `p` `figcaption` `footnote` `table_raw`
`equation` `figure`. 판독기의 세밀한 분류를 여기서 한 번 좁힌다. 좁히는 자리를
백엔드마다 두면 백엔드를 바꿀 때마다 하류가 흔들린다.

`table_raw` 와 `equation` 만 원본 표기를 **보존**한다. 표는 구조가 곧 내용이라
HTML 태그를 그대로 두고, 수식은 LaTeX 를 구분자째 남긴다.

그림은 `assets` 에 base64 로 **함께 실린다**. 사이드카 폴더로 빼면 JSON 하나만
복사했을 때 그림이 통째로 사라진다. 파일로 뽑으려면 `--assets-dir`.

## 옵션

| | |
|---|---|
| `--pages 1-20` | `3` · `1-5,9,12-14` · 생략하면 전부 |
| `--mode accurate` | `fast` 는 텍스트 레이어를 긁어 **인라인 수식을 놓친다** |
| `--dpi 200 --long-edge 2200` | 크게 보낼수록 정확하지만 느리고 비싸다 |
| `--workers 8` | 요율 제한은 안에서 물러나며 처리한다 |
| `--no-cache` | 재실행이 전부 다시 과금된다 |
| `--assets-dir figs/` | 그림을 파일로도 |

## 백엔드

지금은 `datalab`([Datalab API](https://www.datalab.to) — Marker 를 호스팅한 서비스)
하나다. 백엔드는 「쪽 이미지 → 블록」만 하면 되므로, 추가하려면
`backends/` 에 모듈 하나와 등록 한 줄이면 된다.

```bash
vlmparse backends
```

## 밟은 자리

책 네 권을 태우며 얻은 것들이다. 새로 짜면 같은 자리를 다시 밟는다.

- **429 는 실패가 아니라 순서 대기다.** 물러나지 않으면 244쪽 중 219쪽이 「판독 실패」로 남는다.
- **전송 오류도 물러나야 한다.** 상태 코드만 보면 연결 끊김이 그대로 빈 쪽이 된다(175쪽 중 8쪽).
- **과금 단위는 센트다.** `total_cost: 1` 은 1¢ 지 $1 이 아니다 — 100배 오보로 작업을 접을 뻔했다.
- **asset id 는 내용 sha1 이어야 한다.** 판독기 파일명은 레이아웃 기반이라 서로 다른 그림 16장이 같은 이름으로 온다.
- **그림은 유형과 무관하게 줍는다.** 표지 그림이 `SectionHeader` 안에 `<img>` 로 내장되어 온다.
- **`markdown` 이 아니라 `chunks` 로 받는다.** markdown 은 유형이 없어 그림 설명문이 h1·본문으로 샌다.

## 라이선스

MIT
