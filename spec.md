# Parallax — 엔진·데이터 구조 스펙

`pdf2parallax` 파이프라인과 병렬 대역 리더를 Electron 앱의 엔진·뷰로 편입하기 위한 설계 문서.

> **이 문서의 위치.** 기존 Parallax 스펙 M3의 엔진·데이터 계층을 확정하고, UI·사용자 흐름은 `pdf2parallax`가 내는 병렬 대역 리더를 그대로 채택한다. M3의 톤앤매너 템플릿 UI는 폐기한다(§0.1).

## 0. 결론부터

**배치 번역과 스크롤 구동 번역은 다른 아키텍처가 아니다. 같은 작업 큐에 다른 스케줄러를 붙인 것이다.**

- 배치 = 큐에 전 블록을 낮은 우선순위로 넣고 끝까지 돈다
- 스크롤 구동 = 뷰포트에 들어온 블록을 최우선으로 밀어 넣는다

저장소·캐시·청킹·용어집·검증은 완전히 공유된다. 이걸 인정하면 파이프라인 스킬과 Parallax가 하나의 코드베이스가 된다.

두 번째 결론: **`book.json` 통짜 파일은 앱에서 쓸 수 없다.** 블록 하나 번역할 때마다 2,000개짜리 파일을 다시 쓰는 구조이기 때문이다. SQLite로 간다 — 포맷 명세는 §2.2.

세 번째: **작업 파일 하나에 원문과 번역이 함께 들어간다.** `book.md`는 번역만 남고 `book.html`은 읽기용으로 굳은 결과물이라 둘 다 되돌릴 수 없다. `.parallax`가 편집 가능한 형태이고, CLI와 앱이 이 파일로 왕복한다.

### 0.1 확정된 범위

| 항목 | 결정 |
|---|---|
| UI·사용자 흐름·레이아웃 | 현재 리더를 그대로 이식. M3의 별도 UI 안은 폐기 |
| 번역 문체 | **에세이체 하나로 고정.** register 선택 없음 |
| 언어 | **EN → KO 고정.** 다국어 여지를 두지 않음 |
| 번역문 편집 | v1에서 지원하지 않음 (읽기 전용) |
| 원본 변경 시 | 기존 번역 유지. 재추출은 사용자가 명시적으로 요청할 때만 |

이 다섯 결정이 스키마·IPC·UI를 모두 줄인다. 아래 본문은 이미 반영된 상태다.

---

---

## 1. 프로세스 구조

```
┌─ main ─────────────────────────────────────────────┐
│  창·메뉴·파일 대화상자                              │
│  SQLite (better-sqlite3, 동기 API)                  │
│  safeStorage — API 키                               │
│  job orchestrator                                   │
└────────────┬───────────────────────┬────────────────┘
             │ IPC                   │ fork
┌────────────▼──────────┐  ┌─────────▼─────────────────┐
│  renderer             │  │  utility process          │
│  (contextIsolation)   │  │  translate / deslop /      │
│  리더 UI              │  │  pagecheck 워커            │
│  네트워크 접근 없음    │  │  LLM API 호출 전담         │
└───────────────────────┘  └─────────┬─────────────────┘
                                     │ spawn
                           ┌─────────▼─────────────────┐
                           │  python sidecar           │
                           │  PyMuPDF 추출·래스터화     │
                           │  (Tier 1)                 │
                           └───────────────────────────┘
```

**왜 utility process인가.** LLM 호출은 수백 건이 동시에 돈다. main에서 돌리면 SQLite 쓰기와 IPC가 밀린다. `utilityProcess.fork()`로 분리하고 결과만 main에 넘겨 커밋한다.

**왜 python sidecar인가.** Node의 PDF 라이브러리는 폰트 메트릭·좌표 추출이 약하다. `extract.py`가 이미 PyMuPDF로 검증된 코드이므로 그대로 쓴다. M3의 tiered ingestion(Tier 0 Node / Tier 1 Python / Tier 2 cloud VLM)과 그대로 맞물린다.

**패키징 주의.** `better-sqlite3`는 네이티브 모듈이라 `electron-rebuild` 필요. Python sidecar는 PyInstaller로 단일 실행 파일로 굳혀 동봉한다(사용자에게 Python 설치를 요구하지 않는다).

---

## 2. 데이터 구조

### 2.1 파일 배치

```
~/Library/Application Support/Parallax/     (macOS)
  library.db          문서 목록·최근 항목·설정
  cache.db            LLM 응답 캐시 — 문서 간 공유
  keys                safeStorage 암호화된 API 키
  docs/
    <uuid>.parallax   문서 하나 = SQLite 파일 하나
    <uuid>.assets/    페이지 PNG(옵션), 원본 사본
```

**문서 하나 = 파일 하나**로 두면 사용자가 통째로 옮기거나 백업할 수 있다. `.parallax`는 확장자만 바꾼 SQLite다.

**캐시는 문서 밖에 둔다.** 같은 문단이 다른 문서에 또 나오는 경우(개정판, 발췌본)에 재사용되고, 문서를 지워도 캐시는 남는다.

### 2.2 `.parallax` 파일 포맷

**한 파일에 원문과 번역이 함께 들어간다.** 영어 원문은 처음 만들 때 전량 채워지고, 한국어는 번역이 진행된 만큼 같은 행에 채워진다. 그래서 번역이 0%인 파일도 유효하며(앱이 열어 스크롤하며 채운다), 100%인 파일은 완성된 대역본이다.

실측 예 — 191쪽 논픽션 한 권:

| | 블록 | 분량 |
|---|---|---|
| `block.src` 영어 원문 | 1,868 / 1,868 | 384,233자 |
| `block.ko` 한국어 번역 | 29 / 1,868 | 2,669자 |
| 파일 크기 | | 651 KB |

원문이 전량 들어가므로 **파일 크기는 번역 진행률과 거의 무관하다.** 완역해도 1.5배 남짓이다.

#### 식별과 버전

- 실체는 SQLite 3 데이터베이스다. 첫 16바이트가 `SQLite format 3\0`이다.
- 확장자만 `.parallax`로 바꿔 쓴다. 별도 매직 헤더를 두지 않는다 — 어떤 SQLite 도구로도 열려야 진단이 쉽다.
- 버전은 `doc.schema_version` 정수 하나. 현재 **2** (v2: `asset` 테이블과 `figure` 블록 유형 추가).
- 앱은 자신이 아는 버전보다 높은 파일을 열지 않고 안내만 한다. 낮은 파일은 마이그레이션한다.

#### doc — 문서 한 건 (항상 1행)

```sql
CREATE TABLE doc (
  id             TEXT PRIMARY KEY,   -- UUID v4
  title          TEXT,               -- 원서 제목
  title_ko       TEXT,               -- 한국어 제목. 용어집에서 확정되면 채워진다
  author         TEXT,
  source_path    TEXT,               -- 만들 당시의 원본 경로. 참고용
  source_hash    TEXT,               -- 원본 SHA-1. 변경 감지에만 쓴다 (§3)
  source_kind    TEXT,               -- pdf | md | txt
  pages          INTEGER,            -- 원본 쪽수. md/txt는 NULL
  schema_version INTEGER,
  created_at     INTEGER,            -- unix seconds
  updated_at     INTEGER
);
```

문체(에세이체)와 언어쌍(EN→KO)은 고정이므로 컬럼으로 두지 않는다(§11.2, §11.3).

#### block — 본문. 이 파일의 전부

```sql
CREATE TABLE block (
  id         TEXT PRIMARY KEY,   -- b0042, b0042a — 영구 불변
  ord        INTEGER NOT NULL,   -- 읽기 순서. 1024 간격 희소 배치
  page       INTEGER,            -- 원본 쪽번호. md/txt는 NULL
  type       TEXT NOT NULL,      -- h1 h2 h3 p quote figcaption footnote table_raw equation figure
  src        TEXT NOT NULL,      -- 영어 원문. 비어 있을 수 없다
  ko         TEXT,               -- 한국어 번역. 미번역이면 NULL
  ko_raw     TEXT,               -- deslop 이전 번역. 없으면 NULL
  state      INTEGER DEFAULT 0,
  flags      INTEGER DEFAULT 0,
  height_px  INTEGER,            -- 렌더러 실측 높이 캐시. 앱 전용
  updated_at INTEGER
);
CREATE INDEX block_ord   ON block(ord);
CREATE INDEX block_state ON block(state, ord);
CREATE INDEX block_page  ON block(page);
```

`src`와 `ko`가 **같은 행**에 있다는 것이 이 포맷의 핵심이다. 병렬 대역 화면의 한 줄이 곧 한 행이고, 블록 ID가 둘을 묶는 유일한 키다.

`type='figure'`만 예외다 — `src`는 본문이 아니라 `asset.id`이고, `ko`는 늘 NULL, `flags`에 `NO_TRANSLATE`가 선다. 리더는 한 행을 좌우로 가르지 않고 그림 하나로 그린다.

**`type='equation'`**(2026-08-15 추가)은 별행 수식이다. `src`는 `$$…$$`로 감싼 LaTeX, `ko`는 늘 NULL, `flags`에 `NO_TRANSLATE`가 선다 — 수식에는 언어가 없다. 리더는 그림과 같이 **좌우 두 칸에 같은 식을 하나씩** 그린다(한쪽을 비우면 그 대역만 읽는 눈이 식을 놓치고 「번역 대기」 자리표시가 영원히 남는다).

본문 단락 안의 **인라인 수식은 `$…$`** 로 `src`·`ko` 안에 그대로 들어간다. 별도 유형을 두지 않는다 — 단락은 단락이고, 그 안에 수식이 섞여 있을 뿐이다.

`schema_version`은 올리지 않았다. **테이블 구조가 그대로**이고 `type`은 원래 자유 문자열이라, 옛 리더가 열어도 깨지지 않고 `$$…$$`가 글자로 보일 뿐이다. 구조가 바뀌지 않은 변화에 버전을 올리면 버전이 「무엇이 달라졌는가」를 말해 주지 못하게 된다.

**`state`**

| 값 | 이름 | 뜻 |
|---|---|---|
| 0 | `UNTRANSLATED` | `ko`가 비어 있다 |
| 1 | `IN_FLIGHT` | 요청이 나갔다. 앱 실행 중에만 유효하며 저장 시 0으로 되돌린다 |
| 2 | `TRANSLATED` | 번역됨. deslop 전 |
| 3 | `DESLOPPED` | deslop까지 끝남. `ko_raw`에 이전 문장이 남는다 |

**`flags`** — 비트 필드

| 비트 | 값 | 이름 | 뜻 |
|---|---|---|---|
| 0 | 1 | `FROM_OCR` | `src`가 PDF 텍스트 레이어가 아니라 페이지 이미지 판독 결과 |
| 1 | 2 | `REBUILT` | 페이지 재구성으로 새로 만들어진 블록 |
| 2 | 4 | `STITCHED` | 페이지 넘김 단락을 흡수한 블록 |
| 3 | 8 | `NEEDS_REVIEW` | deslop 변경률 초과로 손대지 않음 |
| 4 | 16 | `NO_TRANSLATE` | 색인·판권 등 번역 대상 제외 |
| 5 | 32 | `DROPPED` | 머리글·쪽번호로 판정되어 제외 |

`FROM_OCR`는 UI에서 원문 칸 왼쪽 세로선으로 표시된다. 그 칸이 진짜 원문이 아니라는 뜻이므로 지우면 안 된다.

#### superseded — 밀려난 원문 보관

```sql
CREATE TABLE superseded (
  page    INTEGER PRIMARY KEY,
  payload TEXT NOT NULL          -- JSON [{"id","type","src"}]
);
```

페이지 재구성(`REBUILT`)은 텍스트 레이어를 판독 텍스트로 갈아치우는 유일한 경로다. 밀려난 원문은 그 페이지의 **유일한 문자 정확 기록**이므로 버리지 않고 여기 남긴다. 재구성이 잘못됐다고 판단되면 여기서 되살린다.

#### asset — 그림 원본 (v2)

```sql
CREATE TABLE asset (
  id   TEXT PRIMARY KEY,         -- Datalab 이 붙인 콘텐츠 해시 기반 이름
  mime TEXT NOT NULL,            -- image/jpeg | image/png
  w    INTEGER,                  -- 픽셀 크기. 리더의 높이 추정에 쓴다
  h    INTEGER,
  alt  TEXT,                     -- 판독 모델이 쓴 그림 설명. 본문이 아니라 접근성용
  data BLOB NOT NULL
);
```

Datalab 재판독(`--engine datalab`)이 쪽에서 잘라 보낸 그림이다. `figure` 블록의 `src`가 `id`를 가리킨다. 파일 하나로 옮겨 다니는 것이 `.parallax`의 핵심 가치라 사이드카 폴더가 아니라 BLOB 으로 안에 넣는다.

#### glossary — 확정 역어

```sql
CREATE TABLE glossary (
  en     TEXT PRIMARY KEY,
  ko     TEXT NOT NULL,
  kind   TEXT,                   -- term | keep_original
  locked INTEGER DEFAULT 0       -- 1이면 자동 재생성에서 보호
);
```

`kind='keep_original'`은 번역하지 않고 원문 그대로 두는 표기(기업명·지수명)다. 이 경우 `ko`는 `en`과 같다.

#### page_check — 페이지 판독 이력

```sql
CREATE TABLE page_check (
  page       INTEGER PRIMARY KEY,
  coverage   REAL,               -- 판독 토큰 중 텍스트 레이어에 있던 비율
  columns    INTEGER,
  notes      TEXT,
  checked_at INTEGER
);
```

이미 판독한 페이지를 다시 돌리지 않기 위한 기록이자, pagecheck 리포트의 유일한 사본이다(리포트 md 파일은 임시 폴더와 함께 지워진다). 비어 있으면 pagecheck를 한 번도 돌리지 않은 문서다.

- `page = 0` 행은 요약이다 — `notes`에 엔진·모델·수정 통계 한 줄, `coverage`·`columns`는 NULL. 실제 쪽 번호는 1부터라 충돌하지 않는다.
- 쪽별 행의 `notes`는 이상 사유와 판독 메모를 `" — "`로 합친 문자열이다. 스킬 `export.py`와 앱 `db.ts: Doc.create`가 같은 규칙으로 쓴다.

#### 불변식

읽는 쪽이 기대해도 되는 것들. 쓰는 쪽은 반드시 지켜야 한다.

1. `doc`은 정확히 1행이다.
2. `block.id`는 한 번 부여되면 **절대 바뀌지 않는다.** 캐시 키와 내보내기 호환이 여기 걸려 있다.
3. `block.ord`는 중복이 없고 단조증가한다. 읽기 순서는 `ORDER BY ord`가 유일한 정답이며 `id` 정렬과 일치하지 않을 수 있다.
4. `block.src`는 비어 있지 않다. `ko`는 비어 있을 수 있다.
5. `state`와 `ko`는 모순되지 않는다 — `state>=2`이면 `ko`가 차 있다.
6. 블록 삽입은 이웃한 `ord`의 중점을 쓴다. 간격이 소진될 때만 재배치하며, 그때도 `id`는 건드리지 않는다.
7. `height_px`는 순수 캐시다. 지워도 무방하고, 서체·크기·폭이 바뀌면 무효가 된다.

#### 앱 없이 읽기

진단이나 일회성 추출은 SQLite만 있으면 된다.

```bash
sqlite3 book.parallax "SELECT count(*), sum(ko IS NOT NULL) FROM block;"

# 대역본을 텍스트로 뽑기
sqlite3 -separator $'\n' book.parallax \
  "SELECT src || char(10) || coalesce(ko,'(미번역)') || char(10) FROM block ORDER BY ord;"

# 판독 텍스트 블록만 (검수용)
sqlite3 book.parallax "SELECT id,page,substr(src,1,60) FROM block WHERE flags & 1;"
```

CLI 파이프라인으로 되돌리려면 `parallax_import.py`를 쓴다. 블록 ID·순서·양쪽 언어·`ko_raw`·플래그·용어집·`superseded`가 무손실로 왕복한다(검증: 1,868블록 필드 불일치 0건, 재렌더 결과 해시 동일).

#### 취급 주의

원문이 전량 들어 있으므로 **이 파일은 책 한 권 전체를 담고 있다.** 개인 소장·학습용으로만 쓰고 배포하지 않는다. 공유가 필요하면 `--no-source`로 만든 번역 전용 사본을 쓴다.

### 2.3 캐시 스키마 (`cache.db`)

```sql
CREATE TABLE entry (
  key        TEXT PRIMARY KEY,  -- sha1(stage|model|content)
  stage      TEXT,              -- translate | deslop | pagecheck | glossary
  payload    TEXT,              -- JSON {blockId: text} 또는 판독 결과
  bytes      INTEGER,
  hits       INTEGER DEFAULT 0,
  created_at INTEGER,
  used_at    INTEGER
);
CREATE INDEX entry_lru ON entry(used_at);
```

용량 상한(기본 2GB)을 두고 `used_at` LRU로 정리한다.

### 2.4 라이브러리 스키마 (`library.db`)

```sql
CREATE TABLE document (
  id, title, title_ko, source_kind, path, pages,
  progress_read REAL,        -- 마지막 읽은 위치 0..1
  progress_translated REAL,  -- 번역 완료 비율
  last_opened_at, created_at
);
CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT);
```

리더 설정(서체·크기·폭·분할 비율·테마)은 여기 `setting`에 둔다. 지금 HTML은 `localStorage`를 쓰는데, 앱에서는 문서를 옮겨도 따라와야 하므로 앱 설정으로 승격한다.

---

## 3. 문서 열기 흐름

```
파일 선택
  ├─ .pdf  → sidecar extract  → 구조 복원 → [pagecheck 제안] → block 삽입
  ├─ .md   → markdown 파서    → block 삽입            (pagecheck 불필요)
  └─ .txt  → 빈 줄 단락 분할  → [구조 추론 제안] → block 삽입
```

### PDF

`extract.py`를 sidecar 명령으로 감싼다. stdout으로 JSON Lines를 흘려보내 진행률을 실시간 표시한다.

```
$ parallax-sidecar extract --pdf <path> --repair-ocr auto
{"event":"progress","page":12,"of":191}
{"event":"block","id":"b0042","ord":43008,"page":12,"type":"p","src":"..."}
{"event":"warn","code":"cjk_in_text_layer","ratio":0.016}
{"event":"done","blocks":2152}
```

`cjk_in_text_layer` 경고는 UI에서 이렇게 보여준다.

> 이 PDF의 텍스트 레이어는 한국어 OCR로 만들어져 영문 글자 1.6%가 한글로 치환돼 있습니다. 자동 복구했습니다. — [상세] [복구 끄기]

**pagecheck는 자동으로 돌리지 않는다.** 돈이 든다. 추출 직후 요약을 띄우고 사용자가 결정한다.

> 191쪽 · 2,152블록 · 인용 블록 553개(비정상적으로 많음)
> 페이지 판독으로 구조를 교정하시겠습니까? 약 $1.4 · 3분
> [앞 40쪽만 시험] [전체] [건너뛰기]

### 원본이 바뀐 경우

`source_hash`가 다르면 **기존 번역을 그대로 유지하고 알리기만 한다.**

> 원본 파일이 열람 이후 변경되었습니다. 현재 번역본은 이전 원본을 기준으로 합니다.
> [그대로 읽기] [원본 다시 읽어들이기 — 번역이 사라집니다]

재추출은 사용자가 명시적으로 고를 때만 돌고, 그때는 블록·번역을 전부 버리고 새로 만든다. 부분 병합은 하지 않는다 — 블록 경계가 달라지면 어느 번역이 어느 블록에 붙는지 판정할 방법이 없고, 억지로 맞추면 조용히 어긋난 대역본이 남는다.

### Markdown (OCR 산출물 포함)

이번 스킬이 내는 `book.md`도, 다른 OCR 도구가 낸 md도 같은 경로로 들어온다.

- `#`/`##`/`###` → `h1`/`h2`/`h3`
- `>` → `quote`
- 빈 줄 구분 문단 → `p`
- 목록 항목 → `p` (별도 타입 두지 않는다 — 조판이 통일이라 얻는 게 없다)
- 이미지·코드블록 → `NO_TRANSLATE`로 보존

**MD 열기가 가장 중요한 진입점이다.** 이미 번역된 `book.md`를 다시 열면 원문이 없다 — 그래서 스킬의 내보내기에 `.parallax` 번들을 추가해야 한다(§8).

### TXT

빈 줄 기준 단락 분할까지는 결정론적. 장·절 추론은 LLM 한 번 태우는 선택 작업으로 두고, M3의 "semantic meta tags" 요구를 여기서 만족시킨다.

---

## 4. 번역 스케줄러

### 4.1 우선순위 큐

```ts
type Priority = 0 | 1 | 2 | 3;
// 0 뷰포트 안        — 즉시, 동시 4
// 1 뷰포트 ±1화면    — 즉시, 동시 2
// 2 현재 장(chapter)  — 유휴 시
// 3 나머지 전체       — 유휴 시, 동시 1
```

### 4.2 청크 구성

우선순위와 무관하게 **청크 단위로 호출한다.** 블록 하나만 던지면 문맥이 끊겨 품질이 떨어진다.

요청된 블록을 중심으로 앞뒤로 확장해 6,000자를 채우되:

- 장 경계(`h1`)를 넘지 않는다
- 이미 번역된 블록은 청크에 포함하되 **재번역 대상에서 제외**하고 문맥으로만 준다
- 직전 청크의 마지막 2블록(원문+번역)을 참고 문맥으로 붙인다 — 스킬과 동일

### 4.3 스크롤 연동

```
scroll → 150ms 유휴 대기 → 뷰포트 블록 ID 범위 계산
       → 미번역 블록만 추려 P0으로 enqueue
       → 이미 큐에 있고 아직 시작 안 한 항목은 우선순위만 승격
       → 뷰포트를 벗어난 P0 항목은 P2로 강등 (취소하지 않는다)
```

**시작된 요청은 취소하지 않는다.** 어차피 캐시에 들어가므로 버리는 게 손해다.

### 4.4 모드

| 모드 | 시딩 | 용도 |
|---|---|---|
| 현재 장 | 눈이 머무는 장 전체(h1·h2 경계), 보이는 블록은 P0 | 한 장 정독 |
| 전체 | 전 블록 P3, 보이는 블록은 P0 로 승격 | 완역본 확보 |

두 모드가 같은 큐를 쓰므로 도중에 바꿔도 이미 한 일이 버려지지 않는다.

> 「따라가기」(뷰포트만 시딩)는 2026-08-06 에 뺐다 — 스크롤할 때마다 찔끔찔끔
> 번역이 시작되는 것이 읽기를 방해했고, 훑어보기는 「현재 장」이 대신한다.

### 4.5 deslop

번역과 별개 패스를 유지한다(§ 스킬 `decisions.md` 4항). 강도는 에세이체에 맞춰 **중**으로 고정한다(S1 전부 + 3회 이상 반복되는 S2).

앱에서는 **블록이 번역된 뒤 일정 시간(기본 5초) 뷰포트를 벗어나면** deslop을 P3로 건다. 읽는 중에 글자가 바뀌는 건 나쁜 경험이다.

`ko_raw`를 보존하므로 UI에서 "deslop 전/후" 토글이 가능하다.

---

## 5. IPC 계약

renderer는 네트워크·파일시스템에 직접 접근하지 않는다. preload가 노출하는 표면 전부:

```ts
// preload.ts — contextBridge.exposeInMainWorld("parallax", api)
interface ParallaxAPI {
  // 라이브러리
  library: {
    list(): Promise<DocSummary[]>;
    open(id: string): Promise<DocMeta>;
    import(path: string): Promise<{ docId: string }>;   // 진행률은 이벤트로
    remove(id: string): Promise<void>;
  };

  // 블록 — 가상 스크롤이 창 단위로 당겨간다
  blocks: {
    count(docId: string): Promise<number>;
    range(docId: string, from: number, to: number): Promise<Block[]>;  // ord 기준
    outline(docId: string): Promise<Heading[]>;
    setHeight(docId: string, id: string, px: number): Promise<void>;
  };

  // 번역
  translate: {
    request(docId: string, ids: string[], priority: Priority): Promise<void>;
    setMode(docId: string, mode: "chapter" | "all"): Promise<void>;
    pause(docId: string): Promise<void>;
    stats(docId: string): Promise<{ done: number; total: number; spendUsd: number }>;
  };

  // 용어집
  glossary: {
    get(docId: string): Promise<Glossary>;
    set(docId: string, g: Partial<Glossary>): Promise<void>;
    rebuild(docId: string): Promise<void>;
  };

  // 사전
  dict: {
    lookup(word: string): Promise<DictEntry>;   // main이 호출·캐시. renderer는 fetch 안 함
  };

  // 설정·비밀
  settings: {
    get<K extends keyof Settings>(k: K): Promise<Settings[K]>;
    set<K extends keyof Settings>(k: K, v: Settings[K]): Promise<void>;
  };
  keys: {
    status(): Promise<Record<Provider, boolean>>;   // 존재 여부만. 값은 절대 안 나간다
    set(p: Provider, key: string): Promise<void>;
    clear(p: Provider): Promise<void>;
  };

  // 내보내기
  export(docId: string, fmt: "md" | "html" | "parallax" | "pdf"): Promise<string>;

  // 이벤트
  on(ch: "block:updated", cb: (e: { docId: string; ids: string[] }) => void): () => void;
  on(ch: "import:progress", cb: (e: ImportProgress) => void): () => void;
  on(ch: "job:error", cb: (e: JobError) => void): () => void;
}
```

**`block:updated`는 ID 배열만 보낸다.** 본문을 실어 보내면 IPC가 막힌다. renderer는 ID를 받아 자기 창에 걸린 것만 다시 당겨온다.

---

## 6. 렌더러 — 지금 HTML을 어떻게 쪼개나

현재 `book.html`은 인라인 CSS/JS 단일 파일이다. 앱에서는 이렇게 나눈다.

```
renderer/
  reader/
    Reader.tsx          그리드 컨테이너 + 가상 스크롤
    Row.tsx             블록 쌍 한 행 (src cell / ko cell)
    Splitter.tsx        분할 손잡이 — 실측 배치 로직 그대로 이식
    Toolbar.tsx         목차·영문글꼴·한글글꼴·크기·폭·균등·테마
    Toc.tsx             밀어내기 동작 포함
    DictPopup.tsx       최대 높이 기준 배치 로직 그대로 이식
  styles/
    tokens.css          --split --gap --size --ui-size --face-* --weight-* 등
    reader.css          통일 조판 (.row .cell 타이포그래피)
    theme-light.css / theme-night.css
  hooks/
    useBlockWindow.ts   ord 범위 → blocks.range() → 캐시
    useViewportIds.ts   뷰포트 안 블록 ID → translate.request(P0)
    useRowHeights.ts    실측 높이 저장·복원
```

**그대로 가져가는 것**

- 통일 조판(첫 줄 들여쓰기, 단락 여백 0, 좁은 measure)
- 블록 쌍 = 그리드 한 행 → 정렬이 구조적으로 보장, 스크롤 동기화 코드 불필요
- 분할 손잡이를 계산이 아니라 **실측**으로 배치
- 사전 팝업을 **최대 높이 기준**으로 한 번에 배치
- UI 글자가 본문 크기를 따라감(0.8배, 11~19px)
- 목차는 덮지 않고 밀어냄
- 판독 표시는 글자 없이 세로선

### 6.1 가상 스크롤 — 유일한 난제

500쪽 책이면 블록 4,000개 × 2칸 = DOM 노드 8,000개. 그대로 마운트하면 초기 렌더가 수 초 걸린다.

**문제**: 창 단위 렌더링을 하면 "행 높이 = 좌우 중 큰 쪽" 성질이 깨진다. 마운트되지 않은 행의 높이를 모르기 때문이다.

**해법**: 행 높이를 측정해 `block.height_px`에 캐시하고, 창 위아래에 그 합만큼의 스페이서 `<div>`를 둔다.

```
[spacer height=Σ(윗 행 높이)]
[실제 행 40~80개]
[spacer height=Σ(아랫 행 높이)]
```

- 최초 열람 시 높이를 모르는 행은 추정치(타입별 평균)를 쓰고, 스크롤로 지나가며 실측값으로 교체한다
- 폰트·크기·폭·분할이 바뀌면 **모든 높이 캐시를 무효화**한다. 이건 피할 수 없다 — 그래서 설정 변경 시 현재 블록을 앵커로 잡고 스크롤 위치를 복원해야 한다
- 앵커: 뷰포트 상단에서 가장 가까운 블록 ID + 그 블록 내 상대 오프셋 비율

번역이 도착해 오른쪽 칸이 길어지면 그 행만 높이가 바뀐다. `ResizeObserver`로 잡아 스페이서를 갱신하되, **뷰포트 위쪽 행의 높이 변화만 스크롤 보정이 필요하다**(아래쪽은 그냥 밀린다).

### 6.2 양방향 선택 하이라이트 (M3 요구사항)

블록 쌍이 같은 `data-id`를 공유하므로 블록 단위는 이미 된다. **단어 단위**는 정렬 정보가 없어 불가능하다.

**블록 단위로 확정한다.** 지금 구현된 대로 호버·선택 시 양쪽이 함께 강조된다.

문장 단위는 포기한다. 에세이체는 영어 장문을 한국어 여러 문장으로 쪼개므로 문장 수가 애초에 맞지 않는다. 문장 1:1을 지향하는 직역체를 뺀 이상 기술적으로 성립하지 않는다.

단어 단위도 하지 않는다. 정렬 모델(awesome-align 등)을 붙이는 비용 대비 효용이 없다.

---

## 7. 사전

renderer는 `fetch`하지 않는다. `dict.lookup()`이 main으로 가고 main이 외부를 호출한 뒤 `cache.db`에 넣는다. 이렇게 하면:

- CSP를 `default-src 'self'`로 조일 수 있다
- 조회 이력이 캐시되어 재조회가 없다
- 사용자가 프로바이더를 바꿔 끼울 수 있다

```ts
interface DictProvider {
  id: string;
  lookup(word: string): Promise<Partial<DictEntry>>;
}
// 기본: dictionaryapi.dev(영영) + mymemory(영한)
// 선택: 네이버 사전 API(키 필요) — 붙이면 영한 품질이 크게 오른다
```

---

## 8. 내보내기 — 그리고 스킬과의 호환

| 형식 | 내용 |
|---|---|
| `md` | 현재 `render.py`와 동일 |
| `html` | 현재 자립형 병렬 리더 — **공유용 산출물은 계속 이것** |
| `parallax` | 작업 파일 — 원문 전량 + 번역된 만큼 + 용어집 + 판독 이력. §2.2 |
| `pdf` | html을 인쇄 조판으로 굳힘 (A4 가로 대역) |

**스킬 쪽에 추가해야 할 것**: `render.py --format parallax`. 지금은 배치 파이프라인의 결과가 `book.json`으로만 남아 앱에서 열 수 없다. 이걸 붙이면 CLI로 밤새 번역하고 앱에서 읽는 흐름이 생긴다.

역방향도 마찬가지로 앱에서 `book.json`을 내보낼 수 있어야 스킬로 되돌아갈 수 있다.

---

## 9. 보안·비용

- API 키는 `safeStorage.encryptString()`으로 저장. renderer에는 **존재 여부만** 노출
- renderer CSP: `default-src 'self'; img-src 'self' data:; font-src 'self' https://cdn.jsdelivr.net https://fonts.gstatic.com`
  - 웹폰트는 예외로 허용하거나, **앱에서는 SUIT·Noto를 동봉**하는 편이 낫다(오프라인 동작)
- `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`
- 비용 표시: 문서별 누적 지출을 상태바에 상시 표시. 세션 한도 초과 시 일시정지 후 확인
- 모델 선택은 단계별로 분리 — pagecheck는 싼 모델, translate는 좋은 모델. 이건 이미 스킬에서 `PKT_MODEL`/`PKT_VISION_MODEL`로 갈라져 있다

---

## 10. 단계

| 단계 | 범위 | 확인 기준 |
|---|---|---|
| **E1** | MD 열기 · 전체 배치 번역 · 리더 렌더 · SQLite | 스킬이 만든 `book.md`를 열어 지금 HTML과 같은 화면 |
| **E2** | PDF sidecar · 구조 복원 · 한글 OCR 복구 경고 | 191쪽 PDF를 열어 blocks 검수 화면까지 |
| **E3** | 가상 스크롤 · 높이 캐시 · 앵커 복원 | 500쪽 문서에서 초기 렌더 1초 이내 |
| **E4** | 스크롤 구동 스케줄러 · 3가지 모드 · 비용 표시 | 훑어보기만으로 필요한 부분만 번역 |
| **E5** | pagecheck 통합 · 용어집 편집기 | 300쪽 논픽션에서 용어 흔들림 없음 |
| **E6** | 사전 · 내보내기 4종 · `.parallax` 왕복 | CLI↔앱 왕복 |

E1~E3이 실질적인 뼈대다. E4가 Parallax의 차별점이고, E5가 품질을 결정한다.

문체·언어·편집이 전부 고정되면서 원래 E5에 있던 register 선택 UI, 인물관계표 편집기, 번역문 인라인 편집기가 사라졌다. 대략 한 단계 분량이 줄었다.

---

## 11. 결정 기록과 그 대가

다섯 항목 모두 확정됐다. 각각이 무엇을 줄이고 무엇을 포기했는지 남긴다.

### 11.1 UI는 현재 리더를 그대로 쓴다

M3의 톤앤매너 템플릿 UI 안은 폐기. 지금 리더의 툴바 구성(목차 · 영문 글꼴 · 한글 글꼴 · 글꼴 크기 · 본문 폭 · 균등 · 테마), 좌우 분할, 목차 밀어내기, 고정 제목, 사전 팝업이 그대로 앱 UI가 된다.

**얻는 것**: 이미 만들고 검증한 화면이라 UI 설계 단계가 통째로 빠진다. 밟아본 함정(그리드 래퍼, 실측 배치, 최대 높이 예약)도 코드에 이미 반영돼 있다.

### 11.2 문체는 에세이체 하나

register 4종 중 에세이체만 남긴다. 축 노출도, 자유 텍스트 프롬프트도 없다.

**사라지는 것**: register 선택 UI, `doc.register`·`doc.polite` 컬럼, register별 deslop 강도 분기, 캐시 키의 register 성분, **인물관계표 전체**(존대 결정은 소설체 전용이었다).

**대가 — 소설에는 맞지 않는다.** 에세이체는 존대 체계를 "해당 없음"으로 두므로, 소설 대사의 반말·존댓말을 매번 즉흥적으로 정하게 된다. 인물 말투가 챕터마다 흔들린다는 뜻이다. 논픽션·에세이·자기계발서에는 문제없지만 소설을 읽으실 계획이라면 그때 소설체를 되살려야 한다.

되살리기는 어렵지 않다. 스킬(`references/registers.md`, `glossary.py --fiction`)에 4종이 그대로 남아 있으므로, 앱에 `doc.register` 컬럼과 인물표 테이블을 다시 넣으면 된다. **스킬 쪽은 건드리지 않고 그대로 둔다** — CLI는 별개 표면이고, 나중에 필요할 때 참조할 원본이기도 하다.

### 11.3 EN → KO 고정

`src_lang`/`tgt_lang` 컬럼을 두지 않는다. 프롬프트·용어집·deslop 규칙 전부 이 방향 전제로 쓴다.

**대가**: 나중에 방향을 늘리면 스키마 마이그레이션과 프롬프트 재작성이 함께 필요하다. 다만 deslop(한국어 번역투 제거)은 애초에 KO 전용 자산이라 어차피 언어쌍마다 새로 만들어야 한다. 미리 일반화해도 얻는 게 없다.

### 11.4 번역문 편집 없음 (v1)

읽기 전용이다. `PINNED` 플래그, `blocks.edit()` IPC, 스케줄러와 사용자 편집 사이의 충돌 처리가 전부 사라진다.

**대가 — 오역을 앱 안에서 못 고친다.** 현실적인 우회로 두 가지를 둔다.

1. 블록 단위 재번역 — 해당 블록만 캐시를 무시하고 다시 돌린다. 편집이 아니라 재시도이므로 충돌 문제가 없다
2. `md`로 내보내 외부 편집기에서 수정

우회로 1은 E4에 넣는다. 비용이 거의 없고(블록 하나), 오역 대응의 90%를 처리한다.

### 11.5 원본이 바뀌면 기존 번역 유지

`source_hash` 불일치 시 알리기만 하고 그대로 읽는다. 재추출은 명시적 선택이며, 그때는 블록·번역을 전부 버린다.

**부분 병합은 하지 않는다.** 블록 경계가 달라지면 어느 번역이 어느 블록에 붙는지 판정할 방법이 없다. 억지로 맞추면 조용히 어긋난 대역본이 남는데, 이건 번역이 없는 것보다 나쁘다.

---

## 12. 남은 실무 항목

결정 사항은 아니지만 구현 전에 정리가 필요한 것들.

1. ~~스킬에 `--format parallax` 추가~~ — **완료.** `render.py --format md,html,parallax`와 역방향 `parallax_import.py`. 191쪽 문서로 무손실 왕복 검증(필드 불일치 0건, 재렌더 해시 동일).
2. **웹폰트 동봉 여부.** 앱에서는 SUIT·Noto Serif KR을 번들해 오프라인 동작을 보장하는 편이 낫다. 라이선스는 둘 다 OFL이라 문제없다.
3. **ClipSlip과의 코드 공유.** 번역 호출·문체 사양·deslop 규칙은 공유 가능하다. 리더 UI는 성격이 달라 공유 대상이 아니다. 별도 판단 필요.
