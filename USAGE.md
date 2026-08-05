# USAGE — 실행과 검증

현재 상태와 걸린 지점은 `CONTEXT.md`, 설계는 `spec.md`.

---

## 앱 실행

```bash
npm install          # better-sqlite3 를 Electron ABI 로 재빌드한다
npm start            # = npm run build && electron .
```

문서를 바로 열면서 띄우려면 `.parallax` 경로를 인자로 준다:

```bash
npx electron . "D:\projects\parallax\the_meaning_of_your_life_v2.parallax"
```

`.parallax`로 끝나는 인자만 자동으로 열린다(`src/main/index.ts`의 `fileArg`). 다른 형식은 앱 안에서 **파일 → 열기…(Ctrl+O)** 로 연다.

### API 키

**파일 → Anthropic API 키…(Ctrl+K)**. `safeStorage`로 암호화되어 `%APPDATA%\Parallax\keys.bin`에 저장된다. 저장된 키는 다시 표시되지 않는다 — 다이얼로그는 "저장됨 / 환경변수 사용 중 / 없음"만 알려준다. 환경변수 `ANTHROPIC_API_KEY`도 쓰인다(저장된 키가 우선).

키가 없어도 원문 읽기는 된다.

### PDF 를 열면 페이지 검증을 물어본다

앱으로 PDF 를 열면 추출(`extract.py`)이 끝난 뒤 페이지 검증(`pagecheck.py`)을 돌릴지 묻는다. 쪽수와 예상 비용을 그때 알 수 있어 추출 **뒤에** 묻는다.

| 고르는 것 | 하는 일 |
|---|---|
| 건너뛰기 | 추출한 그대로 연다. 표지 조각이 목차에 섞이고 판독 오류가 남는다. |
| 구조만 대조 | `--trust layer`. 글자는 텍스트 레이어 그대로, 제목·순서·누락만 쪽 이미지로 고친다. |
| 전 쪽 재판독 | `--trust vision`. 모든 쪽을 Claude 비전 모델이 이미지에서 다시 받아쓴다(쪽당 과금). |
| 전 쪽 재판독 (Chandra·로컬) | `--engine chandra`. 모든 쪽을 로컬 [Chandra](https://github.com/datalab-to/chandra) OCR 모델이 다시 받아쓴다. 무료·키 불필요, 대신 GPU(`pip install chandra-ocr[hf]`) 또는 `chandra_vllm` 서버가 필요하다. 파이썬에 chandra 가 설치돼 있을 때만 버튼이 보인다. |

기본 선택은 추출이 판정한 텍스트 레이어의 성격을 따른다 — 쪽이 통째로 이미지인 OCR 샌드위치이거나 한글 글리프가 섞여 있으면 「전 쪽 재판독」, 아니면 「구조만 대조」. 판정 결과는 `book.json` 의 `meta.ocr_layer` 이고 추출 로그에도 찍힌다.

돌아가는 동안 화면 아래 가운데에 `페이지 검증 중 · 47 / 191쪽 · 취소` 가 뜬다. **취소해도 문서는 열린다** — `pagecheck.py` 는 끝까지 간 다음에야 `book.json` 을 덮어쓰므로 중간에 멈추면 추출 직후 상태 그대로다. 검증이 실패했을 때도 마찬가지로 추출본으로 연다.

API 키가 없으면 Claude 모드 두 개는 버튼에서 빠지고, Chandra 까지 없으면 묻지 않고 건너뛴다. 아예 묻지 않게 하려면 대화상자의 「다음부터 묻지 말고 건너뛰기」나 **파일 → PDF 열 때 페이지 검증 묻기** 를 끈다.

### 조판 조절

툴바의 **조판** 버튼을 눌러 여는 패널에서 좌우 공통으로 정한다(Esc 나 바깥 클릭으로 닫는다). 설정은 저장되고 다음에 열 때 그대로 복원된다.

| 컨트롤 | 범위 |
|---|---|
| 영문 글꼴 · 한글 글꼴 | 각 13종 |
| 글꼴 크기 | 10~24pt |
| 줄간격 | 1 · 1.2 · 1.5 · 1.8 · 2 (글꼴 크기에 대한 배수) |
| 단락간격 | 없음 · 반 줄 · 한 줄 (줄 높이에 대한 배수) |
| 본문 폭 | 창의 50~100% |
| 테마 | 밝게 · 어둡게 |

단락간격을 주면 첫 줄 들여쓰기는 자동으로 빠진다. 좌우 비율은 가운데 경계선을 끌어서 20~80% 사이로 바꾸고, 패널의 `좌우 폭 균등` 버튼이나 경계선 더블클릭으로 절반 복귀한다. 툴바·목차·사전 글자 크기는 본문을 따라가지 않는다(윈도우 기본 12px 고정).

툴바에 남은 것은 `목차` · `조판` · 번역 범위 · 테마뿐이다. 조판 컨트롤 일곱 개를 한 줄에 늘어놓으면 1400px 에서 이미 가로로 넘쳤다.

### ⚠ 문서를 열면 번역이 자동으로 시작된다

툴바의 `번역` 모드가 `전체`면 문서를 여는 즉시 API를 호출한다. 검증용으로 잠깐 열 때는 비용이 나가므로, 열자마자 멈추거나 모드를 바꿀 것.

```js
// CDP로 조종할 때
await evaluate(`window.parallax.translate.pause(true)`);
```

---

## CLI 파이프라인 (pdf-ko-translate)

### 설치

```bash
unzip pdf-ko-translate.zip -d ~/.claude/skills/
pip install -r ~/.claude/skills/pdf-ko-translate/requirements.txt
```

`requirements.txt`의 `truststore`를 빼지 말 것 — 네트워크에 따라 파이썬만 전 API 호출이 `CERTIFICATE_VERIFY_FAILED`로 죽는다(`CONTEXT.md` 참조).

Windows에서는 `python3`가 Store 스텁이므로 `python`을 쓴다. `run.sh`는 `python3`를 부르니 단계별로 직접 실행하는 편이 확실하다.

### 단계

```bash
export ANTHROPIC_API_KEY=...        # PowerShell: $env:ANTHROPIC_API_KEY=...

python scripts/extract.py   book.pdf --out work/book.json
python scripts/pagecheck.py work/book.json --pdf book.pdf
python scripts/glossary.py  work/book.json
python scripts/translate.py work/book.json --register essay
python scripts/deslop.py    work/book.json
python scripts/verify.py    work/book.json
python scripts/export.py    work/book.json --out out/     # -> out/book.parallax
```

각 단계는 청크 캐시를 쓰므로 중단 후 다시 돌려도 끝난 부분은 재호출하지 않는다.

`extract.py` 와 `pagecheck.py` 는 끝에서 제목 레벨을 두 단계로 눌러 준다 — `CHAPTER 3` 같은 장 표제는 h1, 나머지 제목은 h2. 페이지마다 레벨이 달라져 목차에서 장이 절보다 아래에 놓이는 것을 막는다. 원본 레벨이 필요하면 두 스크립트 모두 `--keep-heading-levels` 를 받는다.

### 텍스트 레이어가 OCR 산출물일 때

스캔본이거나 전자책 화면 캡처를 OCR한 PDF는 텍스트 레이어 자체가 부정확하다(`bom`/`born`, `beSeattle`, `1temporarily`, 분철 하이픈이 `¬`). `extract.py` 가 이걸 판정해 로그에 찍고 `meta.ocr_layer` 에 남긴다 — 쪽 하나를 통째로 덮는 이미지 위에 글자가 얹혀 있으면(OCR 샌드위치) 그 레이어는 판독 산출물이다. 이때만 권한을 뒤집는다:

```bash
python scripts/pagecheck.py work/book.json --pdf book.pdf --trust vision --pages 1-20   # 시험 ($0.15)
python scripts/pagecheck.py work/book.json --pdf book.pdf --trust vision                # 전권 (191쪽 ≈ $1.4)
```

**레이어가 멀쩡한 책에 쓰면 손해다.** 비전 모델은 고어 철자를 현대화하고, 저자의 의도적 오기를 바로잡고, 곧은 따옴표로 바꾼다. 반드시 앞 20쪽으로 먼저 확인할 것.

### 앱 → CLI 역방향

```bash
python scripts/parallax_import.py path/to/doc.parallax --out work/book.json
```

블록 ID·순서·양쪽 언어·deslop 이전 문장·플래그·용어집이 무손실로 돌아온다.

---

## 추출 품질 확인하기

추출이 잘 됐는지는 `work/blocks.txt`를 훑는 게 먼저지만, 수치로 보면 빠르다. `book.json`이든 `.parallax`든 같은 것을 본다.

```bash
python - <<'PY'
import json, re, collections
b = json.load(open('work/book.json', encoding='utf-8'))['blocks']
t = ' '.join(x['src'] for x in b)
T = re.compile(r'[.!?…”"’)\]]\s*$')
ps = [x for x in b if x['type'] == 'p']
print('블록', len(b), '· 글자', f'{len(t):,}')
print('미종결 단락      ', sum(1 for x in ps if not T.search(x['src'])), '/', len(ps))
print('소문자 시작 단락 ', sum(1 for x in ps if re.match(r'^[a-z]', x['src'])))
print('¬ 단어절단       ', len(re.findall(r'\w\u00ac\s*\w', t)))
print('붙은단어(aB)     ', len(re.findall(r'[a-z][A-Z]', t)))
print('I를 1로          ', len(re.findall(r'\b[01](?=[a-zA-Z]{3,})', t)))
h = [x for x in b if x['type'][0] == 'h']
d = collections.Counter(x['src'] for x in h)
print('제목', len(h), '· 최다중복', d.most_common(2))
PY
```

읽는 법:

| 신호 | 뜻 |
|---|---|
| 미종결 단락이 단락의 20% 넘음 | 페이지 경계 병합이 안 돌았다 |
| 소문자 시작 단락이 많음 | 위와 같은 원인 |
| 제목 최다중복이 5회 이상 | 러닝 헤더가 제목으로 들어갔다 |
| 제목 레벨이 h1/h2 외에 있음 | 정규화가 안 돌았다 — `--keep-heading-levels` 를 준 게 아닌지 확인 |
| 붙은단어·`I→1`이 많음 | 텍스트 레이어가 OCR 산출물 → `--trust vision` 검토 |
| 제목이 `T`, `M`, `—` 같은 조각 | 표지의 큰 글자가 제목으로 분류됐다 |

`.parallax`를 직접 볼 때:

```bash
python -c "
import sqlite3
c = sqlite3.connect('file:book.parallax?mode=ro', uri=True)
print(c.execute('select title, pages from doc').fetchone())
for r in c.execute('select type, count(*) from block group by type order by 2 desc'): print(r)
print('번역', c.execute('select count(*) from block where ko is not null').fetchone())
print('STITCHED', c.execute('select count(*) from block where flags&4').fetchone())
"
```

Windows PowerShell에서 한국어가 깨지면 `$env:PYTHONIOENCODING='utf-8'`.

`node`로 `better-sqlite3`를 직접 부르면 ABI가 안 맞아 실패한다(Electron용으로 빌드돼 있다). 파이썬 `sqlite3`를 쓸 것.

---

## 앱을 자동으로 조종해 확인하기

Playwright가 없어도 Electron을 CDP로 조종할 수 있다. Node 22+ 의 내장 `WebSocket`만 쓴다.

```bash
npx electron . "path/to/doc.parallax" --remote-debugging-port=9222
```

그다음 `http://127.0.0.1:9222/json`에서 `index.html` 타깃을 찾아 WebSocket으로 붙고 `Runtime.evaluate`·`Page.captureScreenshot`을 부른다.

**메인 프로세스**(메뉴·`app.getName()` 등)를 봐야 하면 `--inspect=9229`를 함께 주고 `http://127.0.0.1:9229/json`에 붙는다. 메뉴 항목은 이렇게 직접 실행할 수 있다:

```js
const { Menu } = require("electron");
const f = Menu.getApplicationMenu().items.find(i => i.label === "파일");
f.submenu.items.find(i => i.label.includes("API")).click();
```

주의할 점:

- **`location.reload()`를 쓰지 마라.** 렌더러는 다시 뜨지만 열려 있던 문서가 사라진다(main이 `doc:opened`를 다시 보내지 않는다). 문서를 인자로 주고 앱을 새로 띄울 것.
- 메뉴 액셀러레이터(Ctrl+K 등)는 네이티브 메뉴가 처리하므로 **CDP로 주입한 키 이벤트로는 발화하지 않는다.** 위처럼 메인 프로세스에서 `click()`하라.
- 툴바 토글 버튼을 그냥 누르지 말고 상태를 확인하고 원하는 방향으로 맞춰라. 목차가 이미 열려 있는데 누르면 닫힌다(`toc.dataset.open`, `typePanel.dataset.open`).
- 조판 컨트롤은 `#typePanel` 안으로 옮겨졌지만 DOM 에는 늘 있다 — 값만 바꿀 거면 패널을 열 필요가 없다.
- PDF 열기는 중간에 **네이티브 모달**(페이지 검증 여부)에서 멈춘다. CDP 로는 그 상자를 누를 수 없으니, 자동으로 돌릴 때는 설정에서 `pagecheck: "off"` 로 두거나 `.parallax` 를 열어라.
- 슬라이더는 `r.value = ...` 후 `dispatchEvent(new Event("input", {bubbles:true}))`. 높이 재계산이 120ms 디바운스라 1.5초쯤 기다린 뒤 읽는다.
