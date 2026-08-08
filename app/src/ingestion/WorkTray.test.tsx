import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { WorkTray } from "./WorkTray";

it("announces progress, shows only failed filenames, and retries one failed batch", async () => {
  const retryFailed = vi.fn();
  const user = userEvent.setup();
  render(<WorkTray works={[
    { id: "work-1", total: 3, completed: 1, failures: [], status: "running" },
    { id: "work-2", total: 2, completed: 2, failures: [{ sourcePath: "C:\\private\\broken.png", message: "지원하지 않는 이미지" }], status: "failed" },
  ]} retryFailed={retryFailed} />);

  expect(screen.getByText(/가져오는 중/)).toHaveTextContent("1 / 3");
  await user.click(screen.getByRole("button", { name: /실패 1개/ }));
  expect(screen.getByText("broken.png")).toBeInTheDocument();
  expect(screen.queryByText(/private/)).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "실패 파일 다시 시도" }));
  expect(retryFailed).toHaveBeenCalledWith("work-2");
});
