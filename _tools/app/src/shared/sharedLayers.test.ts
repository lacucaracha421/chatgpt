// DESIGN.md §12: existing copies wait for their redesign round; new copies fail.
// Entries are file#name or file#selector. Delete entries when copies disappear.
// Initial snapshot: UPDATE_SHARED_LAYERS_BASELINE=1 npx vitest run src/shared/sharedLayers.test.ts
// Review baseline edits; normal runs never create or expand the baseline.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Baseline = { duplicateExports: string[]; controlClasses: string[] };
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baselinePath = resolve(packageDirectory, "src/shared/sharedLayers.baseline.json");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "preview", "__tests__"].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.[jt]sx?$/.test(entry.name)
      && !/\.(?:test|spec)\.[jt]sx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [path] : [];
  }).sort();
}

// Mask comments and strings: documentation examples are not declarations.
// Text heuristic only; regex literals and template interpolations are not parsed.
function codeText(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/g,
    (match) => match.replace(/[^\n]/g, " "));
}

function exportedNames(source: string): Set<string> {
  const code = codeText(source);
  const names = new Set<string>();
  for (const match of code.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*|const\s+|class\s+)([\w$]+)/g)) names.add(match[1]);
  // Local export lists count only locally declared functions, consts and classes.
  // Imports followed by exports and export-from barrels are reuse, not definitions.
  const locals = new Set([...code.matchAll(/\b(?:function\s*\*?\s*|const\s+|class\s+)([\w$]+)/g)].map((match) => match[1]));
  for (const match of code.matchAll(/\bexport\s*\{([^}]+)\}(?!\s*from\b)/g)) {
    for (const item of match[1].split(",")) {
      const binding = item.trim().match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (binding && locals.has(binding[1])) names.add(binding[2] ?? binding[1]);
    }
  }
  return names;
}

function cssSelectors(source: string): string[] {
  const selectors: string[] = [];
  for (const match of source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)) {
    if (match[1].trim().startsWith("@")) continue;
    // Split lists without splitting commas inside functional pseudo-classes.
    let depth = 0;
    let start = 0;
    const list = match[1];
    for (let i = 0; i <= list.length; i += 1) {
      if (list[i] === "(") depth += 1;
      if (list[i] === ")") depth -= 1;
      if (i === list.length || (list[i] === "," && depth === 0)) {
        selectors.push(list.slice(start, i).trim().replace(/\s+/g, " "));
        start = i + 1;
      }
    }
  }
  return selectors;
}

function bareControlSelectors(source: string, shared: Set<string>): string[] {
  return [...new Set(cssSelectors(source).filter((selector) => {
    // Strip balanced functional states, then simple states. Pseudo-elements,
    // attributes, element prefixes and screen scopes are outside this guard.
    let bare = selector;
    while (/(?<!:):[\w-]+\([^()]*\)/.test(bare)) bare = bare.replace(/(?<!:):[\w-]+\([^()]*\)/g, "");
    bare = bare.replace(/(?<!:):[\w-]+/g, "");
    if (!/^(?:\.ui-[\w-]+)+$/.test(bare)) return false;
    const classes = bare.slice(1).split(".");
    const block = classes[0].split("--")[0];
    return shared.has(classes[0]) && classes.every((name) => name === block || name.startsWith(`${block}--`));
  }))].sort();
}

function measure(): Baseline {
  const desktop = new Set(sourceFiles(resolve(packageDirectory, "src"))
    .flatMap((file) => [...exportedNames(readFileSync(file, "utf8"))]));
  const fileName = (file: string) => relative(packageDirectory, file).split("\\").join("/");
  const duplicateExports = sourceFiles(resolve(packageDirectory, "mobile-client")).flatMap((file) =>
    [...exportedNames(readFileSync(file, "utf8"))].filter((name) => desktop.has(name)).map((name) => `${fileName(file)}#${name}`));
  const controls = readFileSync(resolve(packageDirectory, "src/styles/controls.css"), "utf8");
  const shared = new Set(cssSelectors(controls).flatMap((selector) => [...selector.matchAll(/\.(ui-[\w-]+)/g)].map((match) => match[1])));
  const controlClasses = readdirSync(resolve(packageDirectory, "mobile-client"))
    .filter((name) => name.endsWith(".css") && name !== "mobile.css").flatMap((name) => {
      const file = resolve(packageDirectory, "mobile-client", name);
      return bareControlSelectors(readFileSync(file, "utf8"), shared).map((selector) => `${fileName(file)}#${selector}`);
    });
  return { duplicateExports: duplicateExports.sort(), controlClasses: controlClasses.sort() };
}

function violations(category: keyof Baseline, current: string[], baseline: string[]): string[] {
  const messages: string[] = [];
  for (const entry of current) {
    if (baseline.includes(entry)) continue;
    messages.push(category === "duplicateExports"
      ? `${entry}: new tablet duplicate export; import it from src/… instead of copying.`
      : `${entry}: new tablet shared control class definition; import it from src/styles/controls.css instead of copying.`);
  }
  for (const entry of baseline) {
    if (!current.includes(entry)) messages.push(`${entry}: copy no longer exists; remove the entry from the baseline.`);
  }
  return messages;
}

const current = measure();
if (process.env.UPDATE_SHARED_LAYERS_BASELINE === "1") writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Baseline;

describe("PC and tablet shared layers ratchet", () => {
  for (const category of ["duplicateExports", "controlClasses"] as const) {
    it(`keeps ${category} at the recorded baseline`, () => {
      const messages = violations(category, current[category], baseline[category]);
      expect(messages, messages.join("\n")).toEqual([]);
    });
  }

  it("recognizes definitions, reuse, states and screen scopes", () => {
    expect([...exportedNames(`
      export async function dateLabel() {} export const Tile = () => null;
      export default function Card() {} const label = () => ''; export { label as caption };
      export type Count = number; export interface Badge {}
      export { sharedOnly, sharedOnly as renamedShared } from '../src/rules';
      export * from '../src/rules';
      import { count } from '../src/rules'; export { count };
      // export const Comment = 1;
      const example = "export const Example = 1";
    `)].sort()).toEqual(["Card", "Tile", "caption", "dateLabel"]);
    expect(bareControlSelectors(`
      .ui-button, .ui-button:hover:not(:disabled) { color:red; }
      @media (width < 600px) { .ui-button.ui-button--quiet:focus-visible { color:red; } }
      .ui-button--quiet { color:red; }
      .ui-button:has(> .sheet, .other) { color:red; }
      .home-x .ui-button, .screen.ui-button, .ui-button.other,
      .ui-button > svg, .ui-button::before, .ui-unknown { color:red; }
      /* .ui-button:active { color:red; } */
    `, new Set(["ui-button", "ui-button--quiet"]))).toEqual([
      ".ui-button", ".ui-button--quiet", ".ui-button.ui-button--quiet:focus-visible",
      ".ui-button:has(> .sheet, .other)", ".ui-button:hover:not(:disabled)",
    ]);
    for (const [category, entry] of [
      ["duplicateExports", "mobile-client/old.ts#label"],
      ["controlClasses", "mobile-client/old.css#.ui-button"],
    ] as const) {
      expect(violations(category, [], [entry])).toEqual([
        `${entry}: copy no longer exists; remove the entry from the baseline.`,
      ]);
    }
  });
});
