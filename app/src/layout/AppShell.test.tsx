import { cleanup, render, screen } from "@testing-library/react";
// @ts-expect-error The app compiler intentionally omits Node ambient types.
import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { AppShell } from "./AppShell";
import { StatusBar } from "./StatusBar";

afterEach(cleanup);
const styles = readFileSync(`${(new Function("return process")() as { cwd(): string }).cwd()}/src/styles/global.css`, "utf8");
const appRoot = (new Function("return process")() as { cwd(): string }).cwd();
it("uses Korean workspace and status labels", () => {
  render(
    <AppShell
      sidebar={<aside>분류</aside>}
      content={<section>자산</section>}
      status={<StatusBar status={{ loadedCount: 3, selectedAsset: null, loading: true }} progress={null} dropEnabled />}
    />,
  );

  expect(screen.getByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
  expect(screen.getByRole("contentinfo", { name: "라이브러리 상태" })).toHaveTextContent("자산을 불러오는 중입니다.");
  expect(screen.getByRole("contentinfo")).toHaveTextContent("이미지와 영상 파일을 창으로 끌어놓으세요.");
});

it("uses the Lakomics product identity", () => {
  const index = readFileSync(`${appRoot}/index.html`, "utf8");
  const packageJson = JSON.parse(readFileSync(`${appRoot}/package.json`, "utf8"));
  const tauri = JSON.parse(readFileSync(`${appRoot}/src-tauri/tauri.conf.json`, "utf8"));

  expect(index).toContain("<title>Lakomics</title>");
  expect(packageJson.name).toBe("lakomics");
  expect(tauri.productName).toBe("Lakomics");
  expect(tauri.app.windows[0].title).toBe("Lakomics");
  expect(tauri.app.windows[0].decorations).toBe(false);
});

it("constrains the workspace row so the status bar remains in the desktop viewport", () => {
  expect(styles).toContain(".app-shell");
  expect(declarations(".app-shell")).toContain("height: 100vh;");
  expect(declarations(".app-shell")).toContain("grid-template-rows: minmax(0, 1fr) var(--statusbar-height);");
  expect(declarations(".app-shell__workspace")).toContain("min-height: 0;");
  expect(declarations(".app-shell__content")).toContain("min-height: 0;");
  expect(declarations(".classification-sidebar")).toContain("min-height: 0;");
  expect(declarations(".classification-sidebar")).toContain("overflow-y: auto;");
});

it("styles the window controls as native title bar buttons", () => {
  expect(declarations(".window-controls__button--close:hover")).toContain("background: var(--color-danger);");
});

it("shows similarity indexing progress and failures", () => {
  const { rerender } = render(<StatusBar
    status={{ loadedCount: 3, selectedAsset: null, loading: false }}
    progress={null}
    dropEnabled
    similarityIndex={{ running: true, remaining: 51, failed: 0 }}
  />);
  expect(screen.getByRole("contentinfo")).toHaveTextContent("유사 이미지 준비 중 · 51개 남음");

  rerender(<StatusBar
    status={{ loadedCount: 3, selectedAsset: null, loading: false }}
    progress={null}
    dropEnabled
    similarityIndex={{ running: false, remaining: 0, failed: 2 }}
  />);
  expect(screen.getByRole("contentinfo")).toHaveTextContent("해시 생성 실패 2개");
});

function declarations(selector: string): string {
  const start = styles.indexOf(`\n${selector} {`);
  const open = styles.indexOf("{", start);
  const close = styles.indexOf("}", open);
  return start < 0 || open < 0 || close < 0 ? "" : styles.slice(open + 1, close);
}
