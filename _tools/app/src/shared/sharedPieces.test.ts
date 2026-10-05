// DESIGN.md §12: dates, D-day, wording, empty states, skeletons and badges come from one shared
// piece on PC and tablet. Existing exceptions are recorded per file; new ones fail, and a count
// that drops must be lowered here too so the ratchet stays tight.
// Regenerate (review the diff): UPDATE_SHARED_PIECES_BASELINE=1 npx vitest run src/shared/sharedPieces.test.ts
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baselinePath = resolve(packageDirectory, "src/shared/sharedPieces.baseline.json");

/** Patterns that mean a screen formats or builds a shared piece by hand. */
const RULES: Record<string, RegExp> = {
  // Dates go through src/shared/displayDate.ts (displayDate, displayTime, displayDateTime, daysUntil).
  adHocDate: /getMonth\(\)\s*\+\s*1|\.replace\(\/-\/g,\s*["']\.["']\)|toLocale(?:Date|Time)String\(|\$\{[^}]+\}(?:분|시간|일) 전/g,
  // D-day goes through ddayLabel / <DDay>.
  adHocDDay: /`D-\$\{|["']D-["']\s*\+/g,
  // One wording per role (DESIGN.md §12 Words).
  retiredWording: /휴지통으로 이동["'`]|휴지통으로 보내기|메모를 휴지통으로|내 평점|내 점수|좋아요 취소|검색 결과가 없|일치하는 [가-힣]+(?:이|가) 없습니다|새로 고침|다시 불러오기|범위 제거|범위 해제|필터 해제["'`]|쇼케이스에서 제거|이 컬렉션에서 제거|이 앨범에서 제외|이 캐릭터에서 제외/g,
  // Empty blocks are <EmptyState>; the tablet's old .empty-state copy is gone.
  handMadeEmptyState: /className=["'`{][^>]*?(?<![\w-])empty-state(?![\w-])/g,
  // Shared classes are rendered only by their component in src/shared/ui.
  rawSharedClass: /className=["'`][^"'`]*\bui-(?:skeleton|badge|empty-state|section-label)\b/g,
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "preview", "test", "__tests__"].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.[jt]sx?$/.test(entry.name) && !/\.(?:test|spec)\.[jt]sx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [path] : [];
  }).sort();
}

/** Comments are documentation, not UI. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|(?<![:"'`])\/\/[^\n]*/g, "");
}

const exempt = (file: string, rule: string) =>
  (file === "src/shared/displayDate.ts" && (rule === "adHocDate" || rule === "adHocDDay"))
  || (file.startsWith("src/shared/ui/") && rule === "rawSharedClass");

function measure(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const root of ["src", "mobile-client"]) {
    for (const path of sourceFiles(resolve(packageDirectory, root))) {
      const file = relative(packageDirectory, path).split("\\").join("/");
      const code = withoutComments(readFileSync(path, "utf8"));
      for (const [rule, pattern] of Object.entries(RULES)) {
        if (exempt(file, rule)) continue;
        const count = [...code.matchAll(pattern)].length;
        if (count) counts[`${file}#${rule}`] = count;
      }
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

const current = measure();
if (process.env.UPDATE_SHARED_PIECES_BASELINE === "1") writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, number>;

describe("shared pieces ratchet (PC and tablet)", () => {
  for (const rule of Object.keys(RULES)) {
    it(`keeps ${rule} at the recorded baseline`, () => {
      const messages: string[] = [];
      const keys = new Set([...Object.keys(current), ...Object.keys(baseline)].filter((key) => key.endsWith(`#${rule}`)));
      for (const key of keys) {
        const now = current[key] ?? 0;
        const before = baseline[key] ?? 0;
        if (now > before) messages.push(`${key}: ${now} (baseline ${before}) — use the shared piece instead.`);
        if (now < before) messages.push(`${key}: ${now} (baseline ${before}) — lower the baseline.`);
      }
      expect(messages, messages.join("\n")).toEqual([]);
    });
  }

  it("recognizes the patterns it guards", () => {
    const hits = (rule: string, text: string) => [...withoutComments(text).matchAll(RULES[rule]!)].length;
    expect(hits("adHocDate", "`${d.getMonth() + 1}.${d.getDate()}`; v.replace(/-/g, '.'); `${n}분 전`")).toBe(3);
    expect(hits("adHocDate", "// d.getMonth() + 1\nconst key = 1;")).toBe(0);
    expect(hits("adHocDDay", "`D-${days}`")).toBe(1);
    expect(hits("retiredWording", "label: \"휴지통으로 이동\", '내 평점', \"검색 결과가 없습니다\", '일치하는 이름이 없습니다.'")).toBe(4);
    expect(hits("retiredWording", "\"휴지통으로 이동했습니다.\" 'StashDB 새로고침' '검색 결과 없음'")).toBe(0);
    expect(hits("handMadeEmptyState", "<div className=\"empty-state review-empty\"> <p className='ui-empty-state--inline'> <div className=\"notes-empty\">")).toBe(1);
    expect(hits("rawSharedClass", "<span className=\"command-palette__thumb ui-skeleton\" /> <i className=\"ui-badges-x\" />")).toBe(1);
  });

  it("serves the tablet the same components through mobile-client/ui.tsx", () => {
    const ui = readFileSync(resolve(packageDirectory, "mobile-client/ui.tsx"), "utf8");
    for (const name of ["Badge", "CountBadge", "DDay", "EmptyState", "SectionLabel", "Skeleton"]) {
      expect(ui).toMatch(new RegExp(`export \\{[^}]*\\b${name}\\b[^}]*\\} from '\\.\\./src/shared/ui/`));
    }
    const uses = (file: string, name: string) => new RegExp(`<${name}\\b`).test(readFileSync(resolve(packageDirectory, file), "utf8"));
    for (const file of ["src/collections/ReleaseCalendarView.tsx", "mobile-client/ReleaseCalendar.tsx", "src/home/HomeReleaseGrid.tsx", "src/home/HomeAttention.tsx", "src/notes/ledger/LedgerContents.tsx"]) {
      expect(uses(file, "DDay"), file).toBe(true);
    }
  });
});
