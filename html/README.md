# Parallax HTML 뷰어

기존 Electron 앱과 별도로 쓰는 브라우저판이다. [parallax.html](parallax.html)을 Chrome 또는 Edge에서 더블클릭해 연다. 웹 서버나 인터넷은 필요하지 않다.

## 사용법

1. 상단 열기 버튼으로 기존 `.parallax` 파일을 고른다. JSON 변환은 필요하지 않다.
2. 형광펜과 책갈피를 편집한다.
3. 저장 또는 `Ctrl+S`로 `.parallax` 파일에 기록한다. 다른 이름으로 저장은 상단 세 번째 버튼이다.

브라우저가 원본 파일 쓰기 권한을 허용하면 같은 파일에 저장한다. 지원되지 않거나 권한이 거절되면 수정본을 내려받으므로 내려받은 `.parallax` 파일을 보관해야 한다. 원본 Electron 앱에서 책을 닫은 뒤 HTML판으로 여는 편이 안전하다.

기존 번역·목차·그림·수식·형광펜을 읽는다. 새 번역은 하지 않는다. 원문 낱말을 두 번 누르면 저장된 뜻을 먼저 보여 주고, 없으면 Datamuse 영영 사전과 MyMemory 영한 번역을 온라인으로 조회한다. 인터넷 연결이 없으면 외부 사전 링크를 이용할 수 있다. 책갈피는 `.parallax` 내부 `bookmark` 표에 저장한다. 이전에 만든 `.parallax.json`도 열 수 있다.

상단 목차·조판·책갈피 아이콘은 제공된 이미지에서 가져왔다. Markdown 내보내기와 기타 메뉴는 없다.

## Markdown 책 만들기

로컬 Markdown과 그 파일 옆의 이미지 폴더를 `.parallax`에 담을 때는 다음을 실행한다. 기존 대상 파일은 덮어쓰지 않는다.

```powershell
python html/import_markdown.py "C:\books\book.md" "out\book.parallax"
```

한국어 번역은 프로젝트 루트 `.env`의 `OPENAI_API_KEY` 또는 `ANTHROPIC_API_KEY`로 실행한다. 완료한 블록은 즉시 저장하므로 중단되면 같은 명령으로 다시 시작할 수 있다. 긴 책은 아래처럼 Anthropic에서 작은 묶음으로 처리할 수 있다.

```powershell
python html/translate_book.py "out\book.parallax" --provider anthropic --jobs 4 --max-chars 2600 --max-items 8
```

## HTML 다시 만들기

공용 본문 소스는 `../src/reader/reader.js`와 `../src/reader/reader.css`다. 웹 전용 소스는 `index.template.html`, 이 폴더의 `reader.css`, `browser-api.js`, `menu.js`, `toolbar-icons.png`다. 빌드에는 저장소의 `node_modules/katex`와 이 폴더의 `vendor/package/dist/sql-wasm.js`, `sql-wasm.wasm`이 필요하다.

```powershell
node html/build.mjs
```

실행 파일에는 KaTeX·글꼴·SQLite WebAssembly가 모두 들어가며, 실행할 때 다른 파일은 필요하지 않다. SQLite 엔진은 sql.js MIT 라이선스로 배포한다. 원문은 `vendor/package/LICENSE`에 있다. Electron의 `src/`와 `package.json`은 수정하지 않는다.
