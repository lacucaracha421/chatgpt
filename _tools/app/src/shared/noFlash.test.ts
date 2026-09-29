// "No flash on change" ratchet (DESIGN.md §12): counts source patterns that blank or flash a view
// while its content changes. New occurrences fail; counts that fall below the baseline fail too,
// keeping it tight. Regenerate after an intentional change with
//   UPDATE_NOFLASH_BASELINE=1 npx vitest run src/shared/noFlash.test.ts
// A line that must reset on purpose (first load of a different screen, unmount cleanup) can say why
// with a `no-flash-ok: <reason>` comment on the same line; it is then not counted.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Category = "blankingReset" | "hiddenImage";
type Counts = Record<Category, number>;

const sharedDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(sharedDirectory, "..");
const packageDirectory = resolve(sourceDirectory, "..");
const baselinePath = resolve(sharedDirectory, "noFlash.baseline.json");
const categories: Category[] = ["blankingReset", "hiddenImage"];

/** Clearing a list/page/data state to empty — on a filter or scope change this blanks the view. */
const blankingReset = /\bset(?:Page|Items|Data|Rows|Results|List|Assets|Entries)\(\s*(?:null|\[\]|empty[A-Za-z]*\(\))\s*\)/g;
/** `<img … hidden …>`: component classes (display: block) override the attribute, so both images show. */
const hiddenImage = /<img\b[^>]*\shidden(?=[\s=>/])/g;

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "preview") continue;
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name) && !/\.(test|spec|perf\.test)\.[jt]sx?$/.test(entry.name)) files.push(path);
    }
  };
  visit(directory);
  return files.sort();
}

function countFile(source: string): Counts {
  const lines = source.split("\n").filter((line) => !line.includes("no-flash-ok:"));
  const text = lines.join("\n");
  return {
    blankingReset: [...text.matchAll(blankingReset)].length,
    hiddenImage: [...text.matchAll(hiddenImage)].length,
  };
}

function measure(): Record<string, Counts> {
  const result: Record<string, Counts> = {};
  for (const root of [resolve(packageDirectory, "src"), resolve(packageDirectory, "mobile-client")]) {
    if (!existsSync(root)) continue;
    for (const file of sourceFiles(root)) {
      const counts = countFile(readFileSync(file, "utf8"));
      if (categories.some((category) => counts[category] > 0)) result[relative(packageDirectory, file)] = counts;
    }
  }
  return result;
}

describe("no-flash ratchet", () => {
  it("keeps blanking resets and hidden images at their recorded baseline", () => {
    const current = measure();
    if (process.env.UPDATE_NOFLASH_BASELINE === "1" || !existsSync(baselinePath)) {
      writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Record<string, Counts>;
    const files = new Set([...Object.keys(baseline), ...Object.keys(current)]);
    for (const file of files) {
      for (const category of categories) {
        const now = current[file]?.[category] ?? 0;
        const recorded = baseline[file]?.[category] ?? 0;
        expect(now, `${file} ${category}: ${now} vs baseline ${recorded}. A new ${category === "blankingReset" ? "reset to empty blanks the view while it changes (keep the old content until the new arrives, or mark a deliberate first-load reset with no-flash-ok: <reason>)" : "<img hidden> is overridden by classes (hide with inline style; see StableImage)"}; if the count went down, lower the baseline with UPDATE_NOFLASH_BASELINE=1`).toBe(recorded);
      }
    }
  });

  it("detects the patterns it guards", () => {
    expect(countFile("setPage(emptyPage()); setItems([]); setData(null);").blankingReset).toBe(3);
    expect(countFile("setPage(next); setItems(list);").blankingReset).toBe(0);
    expect(countFile("setData(null); // no-flash-ok: other screen").blankingReset).toBe(0);
    expect(countFile('<img src={a} hidden={!shown} alt="" />').hiddenImage).toBe(1);
    expect(countFile('<img src={a} alt="" style={{ visibility: "hidden" }} />').hiddenImage).toBe(0);
  });
});
