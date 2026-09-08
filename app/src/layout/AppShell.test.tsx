import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AppShell } from "./AppShell";
import { StatusBar } from "./StatusBar";

afterEach(cleanup);

it("uses Korean workspace and status labels", () => {
  render(
    <AppShell
      sidebar={<aside>분류</aside>}
      content={<section>자산</section>}
      status={<StatusBar status={{ loadedCount: 3, selectedAsset: null, loading: true }} progress={null} dropEnabled />}
    />,
  );

  expect(screen.getByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
  expect(screen.queryByRole("contentinfo", { name: "라이브러리 상태" })).not.toBeInTheDocument();
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
