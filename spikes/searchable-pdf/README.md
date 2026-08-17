# 스파이크 — 검색 가능한 PDF 만들기 (2026-08-17)

**정식 코드가 아니다.** 「vlmparse 판독으로 원본 스캔본에 투명 텍스트 레이어를 넣을
수 있는가」를 확인하려고 만든 시제품 둘이다. 결론과 실측값은 `CONTEXT.md` 의
「검색 가능한 PDF — 좌표는 Tesseract, 글자는 vlmparse」에 있다.

여기 두는 까닭: 산출물과 캐시는 `D:\ebook\__output__\ocr-compare\` 에 있고 그 폴더는
git 밖이라 언제든 사라진다. **결론에 이른 근거를 남긴다.**

| 파일 | 하는 일 |
|---|---|
| `mklayer2.py` | 1차 시도 — vlmparse 블록 사각형 **안에 글을 다시 흘린다**. 검색·복사는 되지만 낱말이 문단 안에서 표류한다(IoU 중앙값 0.00) |
| `mkhybrid.py` | 2차 — **좌표는 Tesseract 낱말 상자, 글자는 vlmparse**. `difflib` 로 두 낱말 열을 정렬해 배정한다(IoU 중앙값 0.60 · IoU≥0.5 가 90~95%) |

## 돌리려면

둘 다 경로가 박혀 있다(시제품이므로). 필요한 것은 셋.

1. **vlmparse 캐시** — `<work>/.vlmparse-cache/read/<key>.json` 에 원본 chunks(+bbox)가 있고
   `<work>/pages/pNNNN.jpg` 에 보낸 쪽 이미지가 있어야 한다. 좌표 환산 계수를
   `쪽pt / 이미지px` 로 그 이미지에서 잰다.
2. **Tesseract TSV** — `tesseract p09.png p09 -l eng --psm 1 tsv` (300dpi 렌더).
   `mkhybrid.py` 만 쓴다.
3. **유니코드 TTF** — `seguisym.ttf`. 내장 `helv` 는 줄표를 `?` 로 깨뜨린다.

## 정식화할 때 옮겨 갈 것

`vlmparse` 에 `bbox` 를 산출로 남기는 것이 선결이다(지금 `chunks_to_blocks` 가 버려서
이 시제품은 캐시를 직접 뒤졌다). 그 뒤 `vlmparse pdf-layer` 서브커맨드로 옮기고,
남은 결함 둘(배정 경계에서 낱말 하나가 떨어지는 것, 블록 경계에 걸친 줄이 버려지는 것)을
잡는다. 자세한 것은 `CONTEXT.md`.
