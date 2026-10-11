import { expect, it } from "vitest";
import { extrasTagName } from "./extrasNames";
import { defaultReferenceIds } from "./ExtrasPromotionDialog";

it("maps a tag to its Korean name and says whether the spelling is certain", () => {
  expect(extrasTagName("abarai_renji")).toEqual({ name: "아바라이 렌지", sure: true });
  expect(extrasTagName("abby_(wuthering_waves)")).toEqual({ name: "애비", sure: false });
});

it("falls back to a readable form of a tag the table does not know, and marks it unsure", () => {
  expect(extrasTagName("some_new_person_(a_series)")).toEqual({ name: "some new person", sure: false });
  expect(extrasTagName("plain")).toEqual({ name: "plain", sure: false });
});

it("prechecks at most five references spread over the chosen images, all of them when there are few", () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `a${index}`);
  expect(defaultReferenceIds(ids(3))).toEqual(["a0", "a1", "a2"]);
  expect(defaultReferenceIds(ids(5))).toEqual(ids(5));
  expect(defaultReferenceIds(ids(9))).toEqual(["a0", "a2", "a4", "a6", "a8"]);
  expect(defaultReferenceIds(ids(200))).toHaveLength(5);
  expect(defaultReferenceIds(ids(200))[0]).toBe("a0");
  expect(defaultReferenceIds(ids(200))[4]).toBe("a199");
});
