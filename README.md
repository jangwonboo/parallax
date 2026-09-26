# Parallax

영문 원문과 한국어 번역을 나란히 읽는 `.parallax` 뷰어다. Electron 앱과 서버 없는 단일 HTML 뷰어가 **같은 리더 코드**를 사용한다. Electron은 읽는 동안 Anthropic 번역과 사전 조회를 할 수 있고, HTML판은 책에 이미 저장된 번역·사전을 읽으며 형광펜과 책갈피를 저장한다.

## 시작하기

```powershell
npm install
npm start                         # Electron
node html/build.mjs               # html/parallax.html 다시 만들기
```

HTML판은 [html/parallax.html](html/parallax.html)을 Chrome 또는 Edge에서 더블클릭해 연다. 두 뷰어 모두 `.parallax` 파일을 직접 연다. PDF·Markdown을 `.parallax`로 만드는 일은 별도 `pdf2parallax.zip`의 CLI가 맡는다. [HTML판 사용법](html/README.md)과 [CLI 사용법](USAGE.md)을 참고한다.

Electron의 새 번역에는 `ANTHROPIC_API_KEY`가 필요하다. 앱의 **파일 → Anthropic API 키**에서 암호화해 저장하거나 실행 환경변수로 지정한다. 키가 없어도 원문·저장된 번역은 읽을 수 있다.

## 코드 경계

| 경로 | 역할 |
|---|---|
| `src/reader/reader.js`, `reader.css` | 공용 본문 렌더링, 가상 스크롤, 수식, 목차, 형광펜 |
| `src/renderer/` | Electron 화면과 API 키 UI |
| `src/main/`, `src/preload/` | Electron의 SQLite·번역·파일 접근 경계 |
| `html/browser-api.js`, `menu.js`, `reader.css` | 브라우저 SQLite·저장·책갈피와 웹 전용 조판 |
| `src/shared/schema-contract.json` | 두 뷰어가 받아들이는 DB 버전과 필수 컬럼 |
| `vendor/vlmparse/`, `pdf2parallax.zip` | PDF의 Datalab OCR과 `.parallax` 생성 파이프라인 |

Electron 빌드는 공용 리더를 `dist/renderer/`에 복사한다. `html/build.mjs`는 같은 소스를 CSS·KaTeX·SQLite WASM과 함께 단일 HTML에 넣는다. `html/parallax.html`은 배포용 빌드 산출물이다.

`.parallax`는 SQLite 파일이다. 원문·번역·수식·그림·형광펜을 한 파일에 저장한다. 형식은 [스키마 계약](src/shared/schema-contract.json)과 [DB 구현](src/main/db.ts)에 따른다. [spec.md](spec.md)와 [CONTEXT.md](CONTEXT.md)는 과거 설계와 결정의 기록이며, 현재 실행 절차는 이 문서와 `USAGE.md`에 있다.

## 확인

```powershell
npm test
python scripts/make-reader-fixture.py          # 첫 실행 때 작은 가상 책 생성
node scripts/smoke-browser.mjs                # Chrome/Edge에서 화면 확인
node scripts/smoke-browser.mjs --electron     # Electron에서 같은 책 확인
```

브라우저 시험은 제목·수식·그림·형광펜·책갈피를 확인한다. 실제 책은 저작물의 원문이 들어 있어 `out/`과 `*.parallax`가 Git에서 제외된다. 코드와 가상 시험 책 생성기만 버전 관리한다.

## 라이선스

코드는 MIT. 동봉된 SQLite WASM은 [sql.js 라이선스](html/vendor/package/LICENSE)를 따른다. 책 파일의 저작권은 각 원본 저작권자에게 있다.
