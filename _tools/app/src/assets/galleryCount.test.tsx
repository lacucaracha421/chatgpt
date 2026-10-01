import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { galleryRowHeight, migrateGalleryCount, useGalleryCount } from "./galleryCount";

afterEach(() => { cleanup(); localStorage.clear(); });
it("migrates pixels once and shares a persisted integer count between menu and gallery", () => {
  localStorage.clear();
  expect(migrateGalleryCount(180)).toBe(6);
  expect(migrateGalleryCount(320)).toBe(3);
  const menu = renderHook(() => useGalleryCount(180));
  const gallery = renderHook(() => useGalleryCount(320));
  expect(gallery.result.current[0]).toBe(6);
  act(() => menu.result.current[1](9));
  expect(gallery.result.current[0]).toBe(9);
  menu.rerender();
  expect(menu.result.current[0]).toBe(9);
});
it("derives same-height rows from the width, count and representative aspect ratio", () => {
  const items = [{ width: 200, height: 100 }] as Parameters<typeof galleryRowHeight>[0];
  expect(galleryRowHeight(items, 1210, 2, 6)).toBe(100);
  expect(galleryRowHeight(items, 610, 2, 6)).toBe(50);
});
