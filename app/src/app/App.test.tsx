import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryGateway } from "../library/types";
import { App } from "./App";

const summary = { root: "C:\\Lakomics", assetCount: 0 };

function gateway(): LibraryGateway {
  return {
    openLibrary: vi.fn().mockResolvedValue(summary),
    currentLibrary: vi.fn(),
    listClassifications: vi.fn(),
    createClassification: vi.fn(),
    renameClassification: vi.fn(),
    moveClassification: vi.fn(),
    deleteClassification: vi.fn(),
    setAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn(),
    ingestImage: vi.fn(),
  };
}

describe("App", () => {
  beforeEach(() => localStorage.clear());
  afterEach(cleanup);

  it("opens the selected library and shows its path", async () => {
    const user = userEvent.setup();
    const selectFolder = vi.fn().mockResolvedValue("C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={selectFolder} />);

    await user.click(screen.getByRole("button", { name: "라이브러리 선택" }));

    await waitFor(() =>
      expect(libraryGateway.openLibrary).toHaveBeenCalledWith("C:\\Lakomics"),
    );
    expect(screen.getByText("C:\\Lakomics")).toBeInTheDocument();
    expect(localStorage.getItem("lakomics.libraryPath")).toBe("C:\\Lakomics");
  });

  it("restores the saved library path when the app starts", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} />);

    await waitFor(() =>
      expect(libraryGateway.openLibrary).toHaveBeenCalledWith("C:\\Lakomics"),
    );
    expect(screen.getByText("C:\\Lakomics")).toBeInTheDocument();
  });

  it("shows setup and an error when restoring the saved library fails", async () => {
    localStorage.setItem("lakomics.libraryPath", "C:\\Lakomics");
    const libraryGateway = gateway();
    vi.mocked(libraryGateway.openLibrary).mockRejectedValue(
      new Error("라이브러리를 열 수 없습니다."),
    );

    render(<App gateway={libraryGateway} selectFolder={vi.fn()} />);

    expect(
      await screen.findByText("라이브러리를 열 수 없습니다."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "라이브러리 선택" }),
    ).toBeInTheDocument();
  });
});
