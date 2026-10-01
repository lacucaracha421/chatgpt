import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CASE_PLASTIC, workCasePlatform, type CaseData } from "./CollectionCase";
import { LightCase } from "./LightCase";

afterEach(cleanup);
const book: CaseData = { title: "책 제목", platform: workCasePlatform("manga", null), front: "https://example.invalid/cover", spine: null, privacy: false };

it("draws manga as paper with its cover and printed title rather than a platform template", () => {
  const { container } = render(<LightCase data={book} selected={false} />);
  const object = container.querySelector<HTMLElement>(".collection-light-case--book")!;
  expect(book.platform).toBe("book");
  expect(object.style.getPropertyValue("--plastic")).toBe(CASE_PLASTIC.book);
  expect(object.querySelector(".cs-front img")).toHaveAttribute("src", book.front);
  expect(object.querySelector(".cs-spine .spine-title")).toHaveAttribute("data-title", book.title);
  expect(object.querySelector(".cs-spine img, .tpl")).toBeNull();
});

it("masks both book faces in privacy mode and keeps the selection lift", () => {
  const { container } = render(<LightCase data={{ ...book, privacy: true }} selected />);
  const object = container.querySelector(".collection-light-case--book")!;
  expect(object).toHaveAttribute("data-front");
  expect(object.querySelectorAll(".case-mask")).toHaveLength(2);
  expect(object.querySelector("img, .spine-title")).toBeNull();
});
