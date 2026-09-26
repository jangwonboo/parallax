# 실행과 검증

## 뷰어

Electron은 `npm start`로 연다. **파일 → 열기**에서 `.parallax` 문서를 고르거나 실행 인자로 경로를 준다. PDF·Markdown·TXT 파일은 앱에서 직접 열지 않는다. PDF 변환 절차는 아래에 있다.

HTML판은 `node html/build.mjs`로 만든 [parallax.html](html/parallax.html)을 Chrome 또는 Edge에서 더블클릭해 연다. 상단 아이콘으로 열기·저장·다른 이름으로 저장·목차·조판·책갈피를 조작한다. 서버는 필요하지 않다. HTML판은 기존 번역을 읽으며 새 번역 API를 호출하지 않는다.

Electron의 Anthropic 키는 앱의 **파일 → Anthropic API 키**에서 저장하거나 `ANTHROPIC_API_KEY` 환경변수로 지정한다. 키 없이도 원문과 저장된 번역은 읽힌다. Electron의 번역 모드가 `전체`면 문서를 열 때 새 번역이 시작될 수 있다.

## PDF → `.parallax` (별도 CLI)

저장소의 `pdf2parallax.zip`을 풀고 패키지 의존성을 설치한다. Windows에서는 `python`을 쓴다.

```powershell
python -m zipfile -e pdf2parallax.zip .
python -m pip install -r pdf2parallax/requirements.txt
python pdf2parallax/scripts/extract.py book.pdf --out work/book.json
python pdf2parallax/scripts/pagecheck.py work/book.json --pdf book.pdf --engine datalab
python pdf2parallax/scripts/export.py work/book.json --out out
```

`pagecheck.py --engine datalab`은 프로젝트 루트 `.env` 또는 환경변수의 `DATALAB_API_KEY`를 사용한다. Datalab API는 호출한 쪽수만큼 과금된다. 일부만 시험할 때는 `--pages 1-20 --workers 4`처럼 지정한다. 재실행 시 성공한 쪽은 캐시를 이용한다. 기본 `--tables image`는 표를 쪽 이미지에서 잘라 그림으로 보존한다. `--tables html`은 표 HTML을 블록에 남긴다.

스캔 PDF는 `extract.py`가 임시 OCR 텍스트 레이어를 만들 수 있다. Datalab은 쪽 이미지를 다시 읽어 글과 수식·그림을 구조화한다. `pagecheck-report.md`의 낮은 일치율은 OCR 레이어와 Datalab 결과의 차이이므로 원본 PDF와 대조한다. 20쪽 실제 시험의 선정 쪽과 결과는 [시험 기록](docs/computer_vision_20p_ocr_test.md)에 있다.

필요하면 `glossary.py`, `translate.py`, `deslop.py`, `verify.py`를 `pagecheck.py`와 `export.py` 사이에 실행한다. API 키와 비용은 각 단계의 설정에 따른다. CLI가 만든 `.parallax`는 두 뷰어에서 바로 열린다.

## 변경 후 검증

```powershell
npm test
python scripts/make-reader-fixture.py
node scripts/smoke-browser.mjs
node scripts/smoke-browser.mjs --electron
```

가상 시험 책을 이미 만들었다면 생성 명령은 건너뛴다. `smoke-browser.mjs`는 `PARALLAX_CHROME`으로 지정한 Chrome/Edge 또는 기본 설치 경로를 사용한다. `html/parallax.html`을 수정할 때는 템플릿과 공용 리더를 고친 뒤 빌드로 다시 만든다.
