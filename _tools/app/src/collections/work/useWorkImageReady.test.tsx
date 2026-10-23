import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyntheticEvent } from "react";
import { useWorkImageReady } from "./useWorkImageReady";

afterEach(cleanup);

describe("work image readiness", () => {
  it("renders the consumer only once when the last of 115 images settles", async () => {
    const sources = Object.fromEntries(Array.from({ length: 115 }, (_, index) => [String(index), `/cover/${index}`]));
    const ready = vi.fn();
    let renders = 0;
    const { result } = renderHook(() => { renders++; return useWorkImageReady(sources, ready); });
    const callbacks = result.current;
    const image = document.createElement("img");
    image.decode = vi.fn().mockResolvedValue(undefined);
    document.body.append(image);
    try {
      for (let index = 0; index < 115; index++) {
        image.setAttribute("src", sources[String(index)]);
        await act(async () => { await result.current.loaded(String(index), { currentTarget: image } as SyntheticEvent<HTMLImageElement>); });
        expect(renders).toBe(index === 114 ? 2 : 1);
      }
      expect(ready).toHaveBeenCalledOnce();
      expect(result.current).toBe(callbacks);
      act(() => result.current.failed("114", sources["114"]));
      expect(renders).toBe(2);
    } finally { image.remove(); }
  });

  it("keeps an unchanged in-flight image when another source joins, and rejects replaced sources", () => {
    const ready = vi.fn();
    const { result, rerender } = renderHook(({ sources }) => useWorkImageReady(sources, ready), {
      initialProps: { sources: { first: "/a" } as Record<string, string | null> },
    });
    const original = result.current;
    rerender({ sources: { first: "/a", second: "/b" } });
    act(() => original.failed("first", "/a"));
    expect(ready).not.toHaveBeenCalled();
    const beforeReplacement = result.current;
    rerender({ sources: { first: "/a", second: "/c" } });
    act(() => beforeReplacement.failed("second", "/b"));
    expect(ready).not.toHaveBeenCalled();
    act(() => result.current.failed("second", "/c"));
    expect(ready).toHaveBeenCalledOnce();
  });

  it("does not render for a shelf without a readiness consumer", () => {
    let renders = 0;
    const { result } = renderHook(() => { renders++; return useWorkImageReady({ cover: "/a" }); });
    act(() => result.current.failed("cover", "/a"));
    expect(renders).toBe(1);
  });
});
