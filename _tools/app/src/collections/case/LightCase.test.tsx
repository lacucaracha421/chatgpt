import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CASE_PLASTIC, workCasePlatform, type CaseData } from "./CollectionCase";
import type { CollectionSummary } from "../../library/types";
import { stripPosition } from "../work/coverStrip";
import { CollectionShelfCase, LightCase } from "./LightCase";

const gateway = vi.hoisted(() => ({}));
vi.mock("../../library/LibraryContext", () => ({ useLibrary: () => ({ gateway, library: null }) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const book: CaseData = { title: "책 제목", platform: workCasePlatform("manga", null), front: "https://example.invalid/cover", spine: null, author: "작가 이름", privacy: false };

it("retains measured game cover geometry when the shelf remounts after a work closes", () => {
  const data: CaseData = { ...book, platform: "pc", front: "/geometry-game-cover" };
  const first = render(<LightCase data={data} selected={false} />);
  const image = first.container.querySelector<HTMLImageElement>(".cs-front img")!;
  Object.defineProperties(image, { naturalWidth: { value: 600 }, naturalHeight: { value: 900 } });
  fireEvent.load(image);
  const ratio = first.container.querySelector<HTMLElement>(".collection-light-case")!.style.getPropertyValue("--case-ratio");
  expect(Number(ratio)).toBeCloseTo(2 / 3);
  first.unmount();
  const second = render(<LightCase data={data} selected={false} />);
  expect(second.container.querySelector<HTMLElement>(".collection-light-case")!.style.getPropertyValue("--case-ratio")).toBe(ratio);
});

it("prints the shared vertical title, front cover strip and author on a shelf book", () => {
  const { container } = render(<LightCase data={book} selected={false} />);
  const object = container.querySelector<HTMLElement>(".collection-light-case--book")!;
  expect(book.platform).toBe("book");
  expect(object.style.getPropertyValue("--plastic")).toBe(CASE_PLASTIC.book);
  expect(object.querySelector(".cs-front img")).toHaveAttribute("src", book.front);
  expect(object.querySelector(".manga-jspine-title")).toHaveTextContent(book.title);
  expect(object.querySelector(".manga-jspine-author")).toHaveTextContent(book.author!);
  expect(object.querySelector(".cs-spine img")).toHaveAttribute("src", object.querySelector(".cs-front img")!.getAttribute("src"));
  expect(object.querySelector<HTMLImageElement>(".cs-spine img")!.style.objectPosition).toBe("50% 30%");
  expect(object.querySelector(".tpl, .manga-jspine-number, .manga-jspine-ruler")).toBeNull();
});

it("masks both book faces in privacy mode and keeps the selection lift", () => {
  const { container } = render(<LightCase data={{ ...book, privacy: true }} selected />);
  const object = container.querySelector(".collection-light-case--book")!;
  expect(object).toHaveAttribute("data-front");
  expect(object.querySelectorAll(".case-mask")).toHaveLength(2);
  expect(object.querySelector("img, .manga-jspine")).toBeNull();
});

it("passes the PC summary author without fetching manga detail or guessing a volume number", () => {
  const collection = { id: "manga", name: book.title, type: "manga", author: book.author, publisher: null, platforms: null, updatedAt: "r1" } as CollectionSummary;
  const { container } = render(<CollectionShelfCase collection={collection} front={book.front} privacy={false} active selected={false} />);
  expect(container.querySelector(".manga-jspine-author")).toHaveTextContent(book.author!);
  expect(container.querySelector(".cs-spine img")).toHaveAttribute("src", book.front);
  expect(container.querySelector(".manga-jspine-number")).toBeNull();
});

it("keeps both faces until both replacement elements decode, and reuses a previously painted cover", async () => {
  const { container, rerender } = render(<LightCase data={book} selected={false} />);
  const images = (src: string) => [...container.querySelectorAll<HTMLImageElement>("img")].filter(image => image.getAttribute("src") === src);
  const first = images(book.front!);
  await act(async () => first.forEach(image => fireEvent.load(image)));
  expect(first.every(image => image.style.visibility === "")).toBe(true);
  rerender(<LightCase data={{ ...book, front: "/next" }} selected={false} />);
  const next = images("/next");
  let decoded!: () => void;
  Object.defineProperty(next[1], "decode", { value: () => new Promise<void>(resolve => { decoded = resolve; }) });
  await act(async () => next.forEach(image => fireEvent.load(image)));
  expect(first.every(image => image.style.visibility === "")).toBe(true);
  expect(next.every(image => image.style.visibility === "hidden")).toBe(true);
  await act(async () => decoded());
  expect(next.every(image => image.style.visibility === "")).toBe(true);
  expect(first.every(image => image.style.visibility === "hidden")).toBe(true);
  rerender(<LightCase data={book} selected={false} />);
  expect(first.every(image => image.style.visibility === "")).toBe(true);
  expect(next.every(image => image.style.visibility === "hidden")).toBe(true);
});

it("uses the passed cover focus without measuring shelf text or creating observers", () => {
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  const { container } = render(<LightCase data={{ ...book, coverFocus: .25, volumeNumber: 1 }} selected={false} />);
  expect(container.querySelector<HTMLImageElement>(".cs-spine img")!.style.objectPosition).toBe(`${stripPosition(.25, .71, .08)}% 30%`);
  expect(container.querySelector(".manga-jspine-number")).toHaveTextContent("1");
  expect(container.querySelector(".manga-jspine-ruler")).toBeNull();
  expect(measure).not.toHaveBeenCalled();
});

it("retains the painted front and strip if the new strip fails", async () => {
  const { container, rerender } = render(<LightCase data={book} selected={false} />);
  const first = [...container.querySelectorAll<HTMLImageElement>("img")];
  await act(async () => first.forEach(image => fireEvent.load(image)));
  rerender(<LightCase data={{ ...book, front: "/bad" }} selected={false} />);
  const next = [...container.querySelectorAll<HTMLImageElement>('img[src="/bad"]')];
  await act(async () => { fireEvent.load(next[0]); fireEvent.error(next[1]); });
  expect(first.every(image => image.style.visibility === "")).toBe(true);
  expect(next.every(image => image.style.visibility === "hidden")).toBe(true);
});

it("ignores stale decodes when an unpainted source changes away and back", async () => {
  const { container, rerender } = render(<LightCase data={book} selected={false} />);
  const front = container.querySelector<HTMLImageElement>(".cs-front img")!;
  const pending: (() => void)[] = [];
  Object.defineProperty(front, "decode", { value: () => new Promise<void>(resolve => pending.push(resolve)) });
  fireEvent.load(front);
  rerender(<LightCase data={{ ...book, front: "/other" }} selected={false} />);
  rerender(<LightCase data={book} selected={false} />);
  await act(async () => container.querySelectorAll("img").forEach(image => fireEvent.load(image)));
  await act(async () => pending[0]());
  expect(front.style.visibility).toBe("hidden");
  await act(async () => pending[1]());
  expect(front.style.visibility).toBe("");
  expect(container.querySelector<HTMLImageElement>(".cs-spine img")!.style.visibility).toBe("");
});
