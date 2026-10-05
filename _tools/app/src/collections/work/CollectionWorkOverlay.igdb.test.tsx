import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryProvider } from "../../library/LibraryContext";
import type { CollectionSummary, LibraryGateway } from "../../library/types";
import { CollectionWorkOverlay } from "./CollectionWorkOverlay";
import type { CollectionWorkData, WorkActions } from "./CollectionWorkScreen";

vi.mock("./useWorkRecord", () => ({
  useWorkRecord: () => ({ ready: true, record: null, save: vi.fn() }),
}));
vi.mock("./CollectionWorkScreen", () => ({
  CollectionWorkScreen: ({ data, actions }: { data: CollectionWorkData; actions: WorkActions }) => {
    const link = actions.onManage(data).find(item => item.id === "provider")!;
    return <button disabled={link.disabled} onClick={link.onSelect}>{link.label}</button>;
  },
}));

afterEach(cleanup);

it("lets a manually created game open IGDB search from its management menu", async () => {
  const collection = { id: "local-game", name: "My game", type: "game" } as CollectionSummary;
  const gateway = {
    listCollectionWorkArtworks: vi.fn().mockResolvedValue([]),
    getIgdbConnection: vi.fn().mockResolvedValue(null),
    importCollectionArtworks: vi.fn().mockResolvedValue(0),
  } as unknown as LibraryGateway;
  render(<LibraryProvider gateway={gateway}>
    <CollectionWorkOverlay collection={collection} collections={[collection]} onExit={vi.fn()} onChanged={vi.fn()} onOpenSettings={vi.fn()} />
  </LibraryProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "IGDB에 연결" }));
  expect(await screen.findByRole("searchbox", { name: "게임 검색" })).toBeInTheDocument();
  expect(gateway.getIgdbConnection).toHaveBeenCalledExactlyOnceWith("local-game");
});
