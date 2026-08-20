/**
 * 형광펜에 든 「어려운 낱말」 고르기.
 *
 * 판정은 SCOWL 의 크기 등급을 그대로 쓴다. 10·20·35 는 일상 어휘이고 40 부터
 * 드물어진다. 표는 빌드가 `dist/main/wordlevels.txt` 로 뽑는다(copy-assets.mjs).
 *
 * 빈도 목록을 웹 코퍼스에서 가져오는 길도 있었는데 산문에는 맞지 않았다 —
 * 실측(《The Conquest of Happiness》 40문단)에서 `happiness`·`suffer`·`unhappy`
 * 까지 「어려움」으로 걸려 낱말의 17%가 표시됐다. SCOWL 은 철자 사전이라
 * 일상 어휘를 빠뜨리지 않는다.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** 이 등급부터 어려운 것으로 친다. 35 로 낮추면 `unhappiness`·`devotion`·
 *  `progressive` 까지 걸린다(실측) — 사전을 볼 낱말이 아니다. */
const FLOOR = 40;
/** 등급에 아예 없는 낱말. 이름이거나 오식이거나 판독 잡티다. */
const UNKNOWN = 99;
/** 한 형광펜에 몇 개까지. 긴 것을 그으면 목록이 사전이 된다. */
const MAX = 3;

let LEVEL: Map<string, number> | null = null;

/** 1.4MB 라 처음 필요할 때 읽는다. 형광펜을 안 쓰는 사람은 낼 일이 없다. */
function levels(): Map<string, number> {
  if (LEVEL) return LEVEL;
  LEVEL = new Map();
  const p = join(__dirname, "wordlevels.txt");
  if (!existsSync(p)) return LEVEL;          // 표가 없으면 아무것도 안 고른다
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0) LEVEL.set(line.slice(sp + 1), Number(line.slice(0, sp)));
  }
  return LEVEL;
}

/** 어미를 벗겨 표제어 후보를 만든다. 사전 조회의 lemmas 와 같은 규칙이다. */
function stems(w: string): string[] {
  const out = [w];
  const add = (x: string) => { if (x.length > 3 && !out.includes(x)) out.push(x); };
  if (/ies$/.test(w)) add(w.slice(0, -3) + "y");
  if (/(ses|xes|zes|ches|shes)$/.test(w)) add(w.slice(0, -2));
  if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
  if (/ing$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -3) + "e"); }
  if (/ed$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); }
  if (/ly$/.test(w)) add(w.slice(0, -2));
  return out;
}

const levelOf = (w: string): number => {
  const L = levels();
  return Math.min(...stems(w).map((s) => L.get(s) ?? UNKNOWN));
};

/**
 * 드문 순으로 최대 세 낱말. 없으면 빈 배열.
 *
 * @param text    형광펜으로 그은 글(원문)
 * @param exclude 이 책의 용어집 표제어. **고유명사를 거르는 자리다** —
 *                SCOWL 은 전부 소문자라 `napoleon`(과자·화폐)과 사람 이름
 *                Napoleon 을 구분하지 못한다. 용어집이 바로 그 책에 나오는
 *                이름들의 목록이라 이보다 정확한 거름망이 없다.
 */
export function hardWords(text: string, exclude: Iterable<string> = []): string[] {
  const skip = new Set<string>();
  for (const t of exclude) for (const w of t.toLowerCase().split(/[^a-z]+/)) if (w) skip.add(w);

  const found = new Map<string, number>();
  const re = /[A-Za-z][A-Za-z'’-]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const w = raw.toLowerCase();
    if (w.length < 5 || !/^[a-z]+$/.test(w)) continue;   // 복합어·소유격은 뺀다
    if (skip.has(w) || found.has(w)) continue;
    /* 문장 첫머리가 아닌데 대문자로 서 있으면 이름이다. 첫머리의 이름은
       용어집이 받는다. */
    const before = text.slice(0, m.index).trimEnd();
    if (/^[A-Z]/.test(raw) && before !== "" && !/[.!?:;]$/.test(before)) continue;
    const lv = levelOf(w);
    if (lv < FLOOR || lv >= UNKNOWN) continue;
    found.set(w, lv);
  }
  /* 드문 것부터. 같은 등급이면 긴 쪽이 대개 더 낯설다. */
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, MAX)
    .map(([w]) => w);
}
