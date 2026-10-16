import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AppShell } from "./AppShell";

afterEach(cleanup);

it("uses the full workspace without reserving a bottom status row", () => {
  render(
    <AppShell
      sidebar={<aside>분류</aside>}
      content={<section>자산</section>}
    />,
  );

  expect(screen.getByRole("main", { name: "라이브러리 작업 공간" })).toBeInTheDocument();
  expect(document.querySelector(".app-shell")?.children).toHaveLength(1);
});
