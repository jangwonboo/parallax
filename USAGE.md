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

### 텍스트 레이어가 OCR 산출물일 때

스캔본이거나 전자책 화면 캡처를 OCR한 PDF는 텍스트 레이어 자체가 부정확하다(`bom`/`born`, `beSeattle`, `1temporarily`, 분철 하이픈이 `¬`). 이때만 권한을 뒤집는다:

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
- 툴바 토글 버튼을 그냥 누르지 말고 상태를 확인하고 원하는 방향으로 맞춰라. 목차가 이미 열려 있는데 누르면 닫힌다.
- 슬라이더는 `r.value = ...` 후 `dispatchEvent(new Event("input", {bubbles:true}))`. 높이 재계산이 120ms 디바운스라 1.5초쯤 기다린 뒤 읽는다.
