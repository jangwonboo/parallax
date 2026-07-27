# CONTEXT — 지금 어디까지 와 있나

새 세션이 이 저장소를 이어받을 때 먼저 읽는 문서. 설계는 `spec.md`, 실행 방법은 `USAGE.md`.

최종 갱신: 2026-07-27

---

## 이 프로젝트는 두 조각이다

| | 무엇 | 어디 |
|---|---|---|
| **Parallax 앱** | 좌우 대역 리더. Electron + better-sqlite3. 읽기와 스크롤 구동 번역. | `src/` |
| **pdf-ko-translate 스킬** | PDF → 구조 복원 → 배치 번역 → `.parallax` 내보내기. Python. | `pdf-ko-translate.zip` |

둘은 `.parallax`(SQLite) 파일로만 오간다. 스키마는 `spec.md` §2.2와 스킬의 `scripts/_parallax.py`에 **이중으로** 적혀 있다 — 한쪽을 고치면 다른 쪽도 고쳐야 한다.

**렌더링은 앱만 한다.** 스킬에 있던 `render.py`와 `templates/`(이북 HTML·테마 CSS)는 2026-07-27에 제거했다. 같은 조판을 두 벌 유지하면 반드시 어긋나고, 실제로 쓰이는 쪽은 앱이다. 스킬의 마지막 단계는 `export.py`(`.parallax` 생성)다.

---

## 앱 상태

`spec.md` §10 기준 E1~E4(스케줄러 포함) 구현. `tsc --noEmit` 통과.

2026-07-27 세션에서 들어간 것:

- 목차 항목을 눌러도 목차가 닫히지 않는다(≥900px). 좁은 화면은 겹쳐 뜨므로 그대로 닫는다. 고른 항목에 `aria-current` 표시.
- 줄간격 슬라이더(1.2~2.4, step 0.02). `--leading`을 움직인다.
- 앱 메뉴 **파일 → Anthropic API 키…**(Ctrl+K). 저장/지우기/상태. 키 값은 renderer로 내려가지 않는다 — 있는지·환경변수인지만 문구로 보여준다.
- 원문 단락 왼쪽 세로줄 제거. PDF 문서는 전 블록에 `FROM_OCR`이 붙어 늘 켜져 있었고, 항상 켜진 표시는 정보가 아니다.
- 툴바를 창 상단 전폭 붙박이로(`position: fixed`). 목차 개폐·글꼴 크기·스크롤과 무관하게 59px 고정. `measureBar()` 및 호출부 제거.
- 툴바의 `열기` 버튼 제거 — 문서 열기는 앱 메뉴(Ctrl+O)로 일원화. 빈 화면의 버튼은 남겼다.
- 목차·책 제목을 **원문 고정**(`db.ts`의 `coalesce(ko, src)` → `src`, `app.js`의 `title_ko || title` → `title`).
- 창 제목을 항상 `Parallax`로. `app.setName` + Windows `setAppUserModelId`.
- 가상 스크롤 높이 추정치를 조판에 연동(아래 참조).
- **PDF 열기가 Windows에서 처음으로 동작한다.** `importers/index.ts`가 `process.env.HOME`(Windows에는 없다)을 보던 것을 `os.homedir()`로, 파이썬을 `"python3"`로 고정해 부르던 것을 `findPython()`으로 바꿨다. Windows의 `python3.exe`는 대개 Microsoft Store로 보내는 0바이트 스텁이라, 후보를 실제로 실행해 보고 고른다. 임시 산출물도 원본 옆이 아니라 임시 폴더에 쓰고 지운다(예전에는 `blocks.txt`와 `*.parallax-extract.json`이 문서 폴더에 남았다).

  스킬이 있어야 동작한다. `findSidecar()`가 보는 곳은 `PARALLAX_SKILL_DIR` → `~/.claude/skills/pdf-ko-translate` → `<cwd>/pdf-ko-translate` → `<cwd>/../pdf-ko-translate` 순이다. 지금은 저장소 안에 `pdf-ko-translate/`로 풀어 뒀다(정본은 zip이고 이 사본은 `.gitignore`에 있다).

### 가상 스크롤 높이 추정 — 알아둘 것

전체 문서 높이는 `index[]`의 블록별 높이 합이다. 조판이 바뀌면 `invalidateHeights()`가 캐시를 버리는데, **실측은 마운트된 30~40행만** 가능하다(나머지는 DOM에 없다). 예전에는 나머지를 타입별 상수로 되돌려서 줄간격을 2배로 늘려도 총 높이가 그대로였다.

지금은 `recomputeEstimates()`가 조판에서 되짚는다:

```
본문 높이 ∝ size² × leading / 칸폭      (줄 수 ∝ size/폭, 줄 높이 ∝ size×leading)
제목 높이 ∝ size                        (line-height 1.35 고정이라 leading을 안 탄다)
```

기준 상수는 191쪽 문서에서 p 487개·h2 40개·h3 20개를 실측해 역산했다(`p: 174`, `h2: 65`, `h3: 42`). **평균으로 보정했다** — 총 높이는 합이라 중앙값이 아니라 평균이 맞다.

실측 오차: 보정에 쓴 조판에서 +1.3%, 쓰지 않은 조판(13px/2.3/65%)에서 −5.9%. 스크롤바 길이용으로는 충분하고, 더 정확하려면 오프스크린 일괄 실측밖에 없다(조판을 만질 때마다 멈칫한다).

---

## 스킬 상태

2026-07-27에 세 가지를 고쳤다. 상세는 `SKILL.md`와 각 함수 주석.

**러닝 헤더 제거** (`extract.py: strip_running_heads`)
- 줄 번호(`lines[:2]`)가 아니라 **페이지 높이의 위·아래 8% 밴드**로 후보를 고른다.
- 임계값 `max(3, 전체의 25%)` → `max(3, 5%)`. 책은 짝수쪽에만 머리글을 넣거나 장 시작에서 빼므로 20%대가 정상인데, 25% 기준이 191쪽 중 37쪽에 있던 머리글을 통과시켰고 `classify()`가 전부 heading으로 읽어 목차가 도배됐다.
- PDF outline에 있는 제목은 절대 지우지 않는다.

**단락 이어붙이기** (`extract.py: stitch_blocks`)
- 원래 `pagecheck.py`에만 있었다. pagecheck는 쪽당 비전 호출이라 대개 건너뛰므로 끊긴 채로 하류에 넘어갔다. extract로 내려 모델 없이 항상 돈다.
- 페이지 경계는 "앞 블록이 종결부호 없이 끝남"만으로 병합한다(뒤가 소문자일 것까지 요구하면 고유명사 앞 절단을 다 놓친다). 같은 페이지 안은 하이픈이나 소문자 시작을 추가로 요구한다.
- OCR이 분철 하이픈을 `¬`(U+00AC)로 쓰는 것까지 복원한다.

**`--trust vision`** (`pagecheck.py`)
- 기존 설계는 "글자는 텍스트 레이어가 정답, 구조는 비전이 정답"이라 판독 텍스트를 일치율 계산에만 쓰고 버렸다. **레이어 자체가 OCR 산출물이면 그 전제가 거짓이다.**
- 이 모드는 전 페이지를 이미지에서 다시 받아쓴다. 밀려난 레이어 텍스트는 `superseded`에 보관하고 새 블록에 `from_ocr`가 붙는다.
- **레이어가 멀쩡한 책에는 쓰지 마라.** 비전은 고어 철자를 현대화하고 저자의 의도적 오기를 고친다. 먼저 `--pages 1-20`으로 시험할 것.

---

## 이 PC 환경에서 물린 것

**`requirements.txt`의 `truststore`를 걷어내지 말 것.** 네트워크 구성에 따라 파이썬만 전 API 호출이 `CERTIFICATE_VERIFY_FAILED`로 죽는 환경이 있다 — 브라우저와 Electron은 멀쩡히 통하는데 파이썬만 죽으므로 키 문제로 오진하기 쉽다. `truststore`는 인증서 검증을 OS에 위임한다. 검증을 끄는 것이 아니라 이 PC의 나머지 프로그램과 같은 판단을 하게 하는 것이다. `SSL_CERT_FILE`로 루트를 추가하는 우회는 통하지 않는 경우가 있다.

**`python3`는 Store 스텁.** 이 PC의 `python3.exe`는 0바이트 재파싱 지점(Microsoft Store 별칭)이다. 진짜 파이썬은 `C:\Python314\python.exe`이고 `python`으로 잡힌다. 스킬의 `run.sh`는 `python3`를 부른다.

**DRM 컨테이너를 PDF로 착각하지 말 것.** 원래 있던 `the_meaning_of_your_life.pdf`(76MB)는 매직 바이트가 `%PDF-`가 아니라 `SCDSA004`인 전자책 DRM 컨테이너였다. PyMuPDF가 열지 못한다. 2026-07-27에 삭제했고, 쓸 수 있는 파일은 `the_meaning_of_your_life_compressed.pdf`(38.6MB, 진짜 `%PDF-1.5`)다. 새 원본을 받으면 먼저 앞 8바이트를 확인하라.

---

## 남아 있는 데이터 파일

작업 파일은 **`the_meaning_of_your_life_v2.parallax` 하나**다(956블록). 2026-07-27에 정리하면서 구 추출본(`the_meaning_of_your_life.parallax`, 1,141블록·번역 943개)과 `README.parallax` 시험 산출물, DRM PDF, 스킬 백업 zip을 지웠다.

구 추출본에 번역이 943개 있었지만 블록 ID가 달라 v2로 옮길 수 없었다. v2 전량 번역은 실측 단가($0.002/블록) 기준 $2 안팎이다.

`.parallax`와 `.pdf`는 `.gitignore`에 있다 — 원문이 전량 들어가고, `.parallax`는 번역이 진행될 때마다 통째로 바뀌는 SQLite라 히스토리에 넣으면 급격히 커진다.

---

## 열려 있는 것

- **앱이 부르는 것은 `extract.py`뿐이다.** 그래서 앱으로 PDF를 열면 표지 조각이 목차에 들어가고(`—`, `T`, `M`) 텍스트 레이어의 OCR 오류도 그대로다. `pagecheck --trust vision`은 CLI 단계라, 품질이 필요하면 파이프라인을 거쳐 `.parallax`를 만들어 열어야 한다. 앱에 pagecheck를 붙이는 것이 `spec.md` §10의 E5다.
- 앱 툴바가 1400px에서 이미 가로 스크롤이 생긴다. 컨트롤이 더 늘면 접어 넣는 메뉴가 필요하다.
- 내보내기(`exporter.ts`, `index.ts:209`)는 아직 `title_ko`를 우선한다. 리더 화면만 원문 고정했다.
- `spec.md` §10의 E5(pagecheck 통합, 용어집 편집기)·E6(`.parallax` 내보내기, 문서 라이브러리) 미착수.
- 블록 단위 재번역 UI 없음(백엔드 `blocks.reset`은 있다).
- 웹폰트를 CDN에서 받는다. 오프라인이면 로컬 대체 서체로 물러난다.
- 스킬의 `glossary`·`translate`·`deslop`·`verify`는 남겨 뒀다. "문서추출만 축소"를 렌더링 제거로 해석했고, README가 "밤새 전량 번역은 CLI가 싸다"는 왕복을 전제하기 때문이다. 번역 단계까지 들어낼지는 미결.
