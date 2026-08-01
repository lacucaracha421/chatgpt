import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "./LibraryContext";
import { LibrarySetup } from "./LibrarySetup";
import type { LibraryGateway } from "./types";

function gateway(): LibraryGateway {
  return {
    openLibrary: vi.fn().mockResolvedValue({ root: "C:\\Lakomics", assetCount: 0 }),
    currentLibrary: vi.fn(),
    listClassifications: vi.fn(),
    createClassification: vi.fn(),
    renameClassification: vi.fn(),
    moveClassification: vi.fn(),
    deleteClassification: vi.fn(),
    listAssets: vi.fn(),
    trashAsset: vi.fn(),
    restoreAsset: vi.fn(),
    listTrash: vi.fn(),
    emptyTrash: vi.fn(),
    getTrashPolicy: vi.fn(),
    setTrashPolicy: vi.fn(),
    setAssetFavorite: vi.fn(),
    setAssetClassifications: vi.fn(),
    getAssetClassifications: vi.fn(),
    ingestImage: vi.fn(),
  };
}

afterEach(cleanup);

it("opens the folder selected during setup", async () => {
  const user = userEvent.setup();
  const libraryGateway = gateway();

  render(
    <LibraryProvider gateway={libraryGateway}>
      <LibrarySetup selectFolder={vi.fn().mockResolvedValue("C:\\Lakomics")} />
    </LibraryProvider>,
  );

  await user.click(screen.getByRole("button", { name: "라이브러리 선택" }));

  await waitFor(() =>
    expect(libraryGateway.openLibrary).toHaveBeenCalledWith("C:\\Lakomics"),
  );
});
