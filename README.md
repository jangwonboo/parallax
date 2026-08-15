# Parallax

영문 문서를 왼쪽에, 한국어 번역을 오른쪽에 나란히 놓고 읽는 Electron 데스크톱 앱.

스크롤하는 만큼만 번역하므로 책 한 권을 통째로 태우지 않아도 읽기 시작할 수 있다. 배치 번역과 스크롤 구동 번역이 같은 작업 큐를 쓰므로 도중에 모드를 바꿔도 이미 한 일이 버려지지 않는다.

설계 근거와 데이터 구조는 `spec.md`, 번역 파이프라인 자체는 `pdf2parallax` 스킬을 참조.

---

## 설치

```bash
npm install          # better-sqlite3 를 Electron ABI 로 자동 재빌드한다
npm start
```

Node 18 이상. 재빌드가 실패하면 `npm run rebuild` 를 수동 실행한다.

### API 키

번역에는 Anthropic API 키가 필요하다. 둘 중 하나:

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # 실행 전에 설정
```

또는 앱 안에서 등록한다. 등록한 키는 `safeStorage` 로 암호화되어 저장되고 renderer 로는 **존재 여부만** 나간다.

키가 없어도 문서를 열어 원문을 읽는 것은 된다.

---

## 여는 형식

| 확장자 | 경로 | 비고 |
|---|---|---|
| `.parallax` | 그대로 연다 | 원문·번역·용어집이 모두 들어 있는 작업 파일 |
| `.md` | 마크다운 파서 | OCR 산출물, `pdf2parallax` 가 낸 `book.md` |
| `.txt` | 빈 줄 단락 분할 | 구조 추론은 하지 않는다 |
| `.pdf` | 파이썬 sidecar | `pdf2parallax` 스킬이 설치돼 있어야 한다 |

PDF 는 `pdf2parallax` 의 `extract.py` 를 그대로 쓴다. Node 의 PDF 라이브러리는 폰트 메트릭·좌표 추출이 약해 구조 복원 품질이 떨어진다.

```bash
# 스킬 설치
unzip pdf2parallax.zip -d ~/.claude/skills/
pip install -r ~/.claude/skills/pdf2parallax/requirements.txt
```

다른 위치에 뒀다면 `PARALLAX_SKILL_DIR` 로 알려준다. 스킬이 없으면 PDF 만 열리지 않고 나머지는 정상 동작한다.

---

## CLI 와의 왕복

밤새 전량 번역은 CLI 가 싸고 빠르다. 앱은 읽기에 좋다. 둘은 `.parallax` 로 오간다.

```bash
# CLI 로 전량 번역 → 앱에서 읽기
python scripts/translate.py work/book.json --register essay
python scripts/render.py    work/book.json --out out/ --format parallax
open out/book.parallax

# 앱에서 읽던 문서를 CLI 로 넘기기
python scripts/parallax_import.py ~/Library/.../docs/xxx.parallax --out work/book.json
```

블록 ID·순서·양쪽 언어·deslop 이전 문장·플래그·용어집이 무손실로 왕복한다.

---

## 구조

```
src/
  shared/types.ts          .parallax 스키마 상수와 공용 타입
  main/
    index.ts               앱 수명주기 · IPC · 사전 · 비밀키
    db.ts                  .parallax 열기/질의/쓰기
    exporter.ts            md · html 내보내기
    importers/index.ts     md · txt 파서, pdf sidecar 호출
    translate/
      prompt.ts            에세이체 사양, deslop 규칙, 와이어 포맷
      scheduler.ts         우선순위 큐 · 청킹 · 재시도 · 비용 집계
  preload/index.ts         contextBridge 표면 (이게 renderer 능력의 전부)
  renderer/
    index.html             CSP: connect-src 'none' — renderer 는 네트워크에 못 나간다
    reader.css             pdf2parallax 의 리더 조판을 공유
    app.js                 가상 스크롤 · 분할 · 서체 · 사전 · 짝 강조
```

### 알아둘 설계

**블록 쌍 = 그리드 한 행.** 좌우 정렬이 구조적으로 보장되므로 스크롤 동기화 코드가 없다. 행 높이는 긴 쪽에 맞춰 늘어난다.

**가상 스크롤.** 1,868블록이면 DOM 노드 3,700개다. 창 밖은 마운트하지 않고 위아래에 실측 높이 합만큼의 스페이서를 둔다. 서체·크기·폭·분할이 바뀌면 높이 캐시가 전부 무효가 되므로 앵커 블록으로 스크롤 위치를 되살린다.

**분할 손잡이와 사전 팝업은 계산이 아니라 실측으로 배치한다.** rem 크기·스크롤바 폭·max-width 클램핑이 얽혀 CSS `calc` 로는 계속 어긋난다. 사전은 현재 높이가 아니라 **최대 높이**를 기준으로 위치를 한 번에 정한다 — 내용이 두 번에 걸쳐 도착하기 때문이다.

**번역문 편집은 없다** (spec §11.4). 오역은 편집이 아니라 **블록 단위 재번역**으로 대응한다. 편집이 없으므로 스케줄러와의 충돌 처리가 통째로 빠진다.

**renderer 는 네트워크에 직접 나가지 않는다.** 사전 조회도 main 을 거친다. CSP 의 `connect-src 'none'` 이 이를 강제한다.

---

## 확인된 것 / 확인되지 않은 것

리눅스 컨테이너에서 Xvfb 로 검증했다.

**동작 확인**

- `npm install` — better-sqlite3 Electron ABI 재빌드 포함
- `tsc --noEmit` 타입 검사 통과
- 191쪽 `.parallax`(1,868블록) 열기 → 제목·목차 142항목·상태표시줄 렌더
- 가상 스크롤 — 초기 29행 마운트, y=4000 스크롤 시 52행에 첫 블록 `b0039` 로 재활용, 스페이서 3,047px 조정, 전체 높이 250,790px
- 마크다운 열기 — 1,871블록, 목차 143항목
- DB 계층 — range · outline · pending · 높이 캐시 왕복 · applyTranslation · resetBlocks
- 내보내기 — md · html

**확인 못 한 것**

- 실제 번역 호출 (API 키 없이 검증)
- macOS · Windows 패키징 (`npm run dist`) — 서명·공증은 별도
- PDF sidecar 경로 (스킬 설치 환경 필요)
- 실사용 스크롤 성능 (헤드리스 캡처만)

---

## 다음 단계

`spec.md` §10 기준으로 E1~E3 과 E4 의 스케줄러가 들어 있다. 남은 것:

- **E5** pagecheck 통합, 용어집 편집기
- **E6** `.parallax` 내보내기(앱 → 파일), 문서 라이브러리 화면
- 웹폰트 동봉 (현재는 CDN 에서 받는다 — 오프라인이면 로컬 대체 서체로 물러난다)
- 블록 단위 재번역 UI (백엔드 `blocks.reset` 는 이미 있다)

## 라이선스

MIT. 서체는 SUIT(OFL), Google Fonts(OFL/Apache).

문서 파일에는 원본이 전량 들어간다. 개인 소장·학습용으로만 쓰고 배포하지 않는다.
