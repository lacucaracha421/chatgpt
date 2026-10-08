import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let created = 0;
beforeEach(() => {
  vi.resetModules();
  created = 0;
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:thumbnail-${++created}`),
    revokeObjectURL: vi.fn(),
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function harness() {
  const module = await import("./vaultThumbnailCache");
  function Tile({ url, enabled = true }: { url: string | null; enabled?: boolean }) {
    return <span data-src={String(module.useVaultThumbnailSrc(url, enabled))} />;
  }
  return { ...module, Tile };
}

it("decrypts a vault thumbnail once and serves it from memory when the tile comes back", async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: () => Promise.resolve(new Blob(["webp"])) });
  vi.stubGlobal("fetch", fetchMock);
  const { Tile, clearVaultThumbnailCache } = await harness();
  const first = render(<Tile url="http://lakomics.localhost/vault-thumbnail/a/v1" />);
  expect(first.container.firstElementChild).toHaveAttribute("data-src", "null");
  await waitFor(() => expect(first.container.firstElementChild).toHaveAttribute("data-src", "blob:thumbnail-1"));
  first.unmount();
  // Another folder shows the same item again: no second request.
  const again = render(<Tile url="http://lakomics.localhost/vault-thumbnail/a/v1" />);
  expect(again.container.firstElementChild).toHaveAttribute("data-src", "blob:thumbnail-1");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("http://lakomics.localhost/vault-thumbnail/a/v1", { mode: "cors", cache: "no-store" });
  act(() => clearVaultThumbnailCache());
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail-1");
});

it("falls back to the plain URL when the WebView cannot fetch it, and passes library URLs through", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("no cors")));
  const { Tile } = await harness();
  const vault = render(<Tile url="lakomics://localhost/vault-thumbnail/a" />);
  await waitFor(() => expect(vault.container.firstElementChild).toHaveAttribute("data-src", "lakomics://localhost/vault-thumbnail/a"));
  const library = render(<Tile url="http://lakomics.localhost/thumbnail/b" enabled={false} />);
  expect(library.container.firstElementChild).toHaveAttribute("data-src", "http://lakomics.localhost/thumbnail/b");
});
