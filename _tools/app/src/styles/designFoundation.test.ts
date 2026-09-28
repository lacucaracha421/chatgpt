// Counts that fall below the baseline fail too, keeping the ratchet tight; regenerate with
// UPDATE_DESIGN_BASELINE=1 npx vitest run src/styles/designFoundation.test.ts.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Category = "offScaleSpacing" | "offRoleFontSize" | "pillRadius" | "legacyToken";
type Counts = Record<Category, number>;
type Baseline = Record<string, Counts>;

const stylesDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(stylesDirectory, "../..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const baselinePath = resolve(stylesDirectory, "designFoundation.baseline.json");
const spacingProperties = /(?:^|[;{}])\s*(?:gap|row-gap|column-gap|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?)\s*:\s*([^;{}]+)/g;
const fontSizeProperty = /(?:^|[;{}])\s*font-size\s*:\s*([^;{}]+)/g;
const fontShorthandProperty = /(?:^|[;{}])\s*font\s*:\s*([^;{}]+)/g;
const borderRadiusProperty = /(?:^|[;{}])\s*border-radius\s*:\s*([^;{}]+)/g;
const spacingValue = /(-?(?:\d+\.?\d*|\.\d+))px\b/g;
const pixelFontSize = /(?:^|\s)(\d+(?:\.\d+)?)px(?:\s*\/|\s|$)/;
const pillValue = /(?:^|\s)(?:999|9999)px(?:\s|$)/g;
const legacyTokenValue = /var\(--(?:space-compact|space-5|text-sm|text-lg|text-section)\)/g;
const categories: Category[] = ["offScaleSpacing", "offRoleFontSize", "pillRadius", "legacyToken"];

function emptyCounts(): Counts {
  return { offScaleSpacing: 0, offRoleFontSize: 0, pillRadius: 0, legacyToken: 0 };
}

function cssFiles(rootDirectory: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "target") continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".css")) files.push(path);
    }
  };
  visit(rootDirectory);
  return files.sort();
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function countOffScaleSpacing(css: string): number {
  const allowed = new Set([0, 1, 2, 4, 8, 12, 16, 24, 32]);
  let count = 0;
  for (const match of css.matchAll(spacingProperties)) {
    for (const value of match[1].matchAll(spacingValue)) {
      if (!allowed.has(Math.abs(Number(value[1])))) count += 1;
    }
  }
  return count;
}

function countOffRoleFontSize(css: string, allowed: Set<number>): number {
  let count = 0;
  for (const match of css.matchAll(fontSizeProperty)) {
    const size = match[1].match(pixelFontSize);
    if (size && !allowed.has(Number(size[1]))) count += 1;
  }
  for (const match of css.matchAll(fontShorthandProperty)) {
    const size = match[1].match(pixelFontSize);
    if (size && !allowed.has(Number(size[1]))) count += 1;
  }
  return count;
}

function countPillRadii(css: string): number {
  let count = 0;
  for (const match of css.matchAll(borderRadiusProperty)) count += countMatches(match[1], pillValue);
  return count;
}

function analyzeCss(filePath: string, device: "desktop" | "tablet"): Counts {
  const css = stripComments(readFileSync(filePath, "utf8"));
  const allowedFontSizes = device === "desktop" ? new Set([12, 15, 20, 24]) : new Set([13, 17, 22, 28]);
  return {
    offScaleSpacing: countOffScaleSpacing(css),
    offRoleFontSize: countOffRoleFontSize(css, allowedFontSizes),
    pillRadius: countPillRadii(css),
    legacyToken: countMatches(css, legacyTokenValue),
  };
}

function repoRelative(filePath: string): string {
  return relative(repositoryDirectory, filePath).split("\\").join("/");
}

function collectBaseline(): { desktop: Baseline; tablet: Baseline } {
  const desktop: Baseline = {};
  for (const filePath of cssFiles(resolve(packageDirectory, "src"))) {
    desktop[repoRelative(filePath)] = analyzeCss(filePath, "desktop");
  }
  const tablet: Baseline = {};
  for (const filePath of cssFiles(resolve(packageDirectory, "mobile-client"))) {
    tablet[repoRelative(filePath)] = analyzeCss(filePath, "tablet");
  }
  return { desktop, tablet };
}

function zeroWhenMissing(baseline: Baseline, path: string): Counts {
  return baseline[path] ?? emptyCounts();
}

function compareCounts(path: string, actual: Counts, baseline: Counts): void {
  for (const category of categories) {
    const current = actual[category];
    const recorded = baseline[category] ?? 0;
    expect(
      current,
      `${path} ${category}: current ${current} exceeds baseline ${recorded}`,
    ).toBeLessThanOrEqual(recorded);
    expect(
      current,
      `${path} ${category}: current ${current} is below baseline ${recorded}; lower the baseline with UPDATE_DESIGN_BASELINE=1`,
    ).toBeGreaterThanOrEqual(recorded);
  }
}

describe("design foundation CSS ratchet", () => {
  it("keeps CSS counts at their recorded baseline", () => {
    const actual = collectBaseline();
    if (process.env.UPDATE_DESIGN_BASELINE === "1") {
      writeFileSync(baselinePath, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
    }
    const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { desktop: Baseline; tablet: Baseline };

    for (const [device, files] of Object.entries(actual) as ["desktop" | "tablet", Baseline][]) {
      for (const [path, counts] of Object.entries(files)) compareCounts(path, counts, zeroWhenMissing(baseline[device], path));
    }
  });

  it("keeps the foundation CSS files clean", () => {
    const actual = collectBaseline();
    expect(actual.desktop["_tools/app/src/styles/tokens.css"]).toEqual(emptyCounts());
    expect(actual.desktop["_tools/app/src/styles/controls.css"]).toEqual(emptyCounts());
  });
});
