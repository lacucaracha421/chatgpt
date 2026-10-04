import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CollectionCase, type CaseData } from "./CollectionCase";
import { displayDate } from "../../shared/displayDate";
import { backFacts } from "../work/workFacts";

afterEach(cleanup);
const data: CaseData = { title: "Game", front: "/front", platform: "sw2", privacy: false };
const props = { open: false, onOpenChange: vi.fn() };

it("generates a back only without real back art and outside privacy mode", () => {
  const { container, rerender } = render(<CollectionCase {...props} data={data} backContent={{ overview: "Story" }} />);
  expect(screen.getByLabelText("생성 뒷표지")).toHaveTextContent("Story");
  rerender(<CollectionCase {...props} data={{ ...data, back: "/real-back" }} />);
  expect(screen.queryByLabelText("생성 뒷표지")).toBeNull();
  expect(screen.getByRole("img", { name: "Game 뒷면" })).toHaveAttribute("src", "/real-back");
  rerender(<CollectionCase {...props} data={{ ...data, privacy: true }} backContent={{ hero: "/secret", overview: "Secret" }} />);
  expect(screen.queryByLabelText("생성 뒷표지")).toBeNull();
  expect(container.querySelector(".k-back .case-mask")).toBeInTheDocument();
  expect(container).not.toHaveTextContent("Secret");
});

it("uses the hero then a darkened front, omitting absent copy and screenshots", () => {
  const { container, rerender } = render(<CollectionCase {...props} data={data} backContent={{ hero: "/hero" }} />);
  expect(container.querySelector(".case-back-hero")).toHaveStyle({ backgroundImage: 'url("/hero")' });
  expect(container.querySelector(".case-back-hero")).not.toHaveClass("is-fallback");
  rerender(<CollectionCase {...props} data={data} backContent={{ overview: "  " }} />);
  expect(container.querySelector(".case-back-hero")).toHaveStyle({ backgroundImage: 'url("/front")' });
  expect(container.querySelector(".case-back-hero")).toHaveClass("is-fallback");
  expect(container.querySelector(".case-back-copy, .case-back-shots")).toBeNull();
  rerender(<CollectionCase {...props} data={{ ...data, front: null }} />);
  expect(container.querySelector(".case-back-hero")).toHaveTextContent("Game");
  expect(container.querySelector<HTMLElement>(".case-back-hero")!.style.backgroundImage).toBe("");
});

it("prints up to three actual screenshots and no rating or barcode", () => {
  const { container } = render(<CollectionCase {...props} data={data} backContent={{ screenshots: ["/1", "/2", "/3", "/4"], publisher: "Publisher", platformName: "Switch 2" }} />);
  expect([...container.querySelectorAll<HTMLImageElement>(".case-back-shots img")].map(img => img.getAttribute("src"))).toEqual(["/1", "/2", "/3"]);
  expect(container.querySelector(".case-back-foot")).toHaveTextContent("PublisherSwitch 2");
  expect(container.querySelector(".case-back .rating, .case-back .barcode")).toBeNull();
});

it("prints localized film facts from the information panel's helpers", () => {
  const facts = backFacts({ type: "movie", director: "Director", productionCompany: "Studio", releaseDate: "2026-09-01", genres: "Action & Adventure · Sci-Fi & Fantasy" }, null);
  const { container } = render(<CollectionCase {...props} data={{ ...data, platform: "film" }} backContent={{ facts }} />);
  expect([...container.querySelectorAll(".case-back-facts dt")].map(node => node.textContent)).toEqual(["감독", "제작", "개봉", "장르"]);
  expect(container.querySelector(".case-back-facts")).toHaveTextContent(`Director제작Studio개봉${displayDate("2026-09-01")}장르액션 & 모험 · SF & 판타지`);
  expect(backFacts({ type: "movie" }, null)).toEqual([]);
});

it("uses AV facts for an AV work without a real back", () => {
  const facts = backFacts({ type: "av" }, { productCode: "ABC-123", maker: "Maker", label: "Label", releaseDate: "2026-09-01", genres: [] });
  const { container } = render(<CollectionCase {...props} data={{ ...data, platform: "av" }} backContent={{ facts, publisher: "Maker" }} />);
  expect([...container.querySelectorAll(".case-back-facts dt")].map(node => node.textContent)).toEqual(["품번", "메이커", "레이블", "발매"]);
  expect(container.querySelector(".case-back-facts")).toHaveTextContent(`ABC-123메이커Maker레이블Label발매${displayDate("2026-09-01")}`);
});

it("defines the print unit on the case whose height is overridden by fitted stages", () => {
  const styles = readFileSync("src/collections/case/CollectionCase.css", "utf8");
  const inside = readFileSync("src/collections/case/CaseInside.css", "utf8");
  const back = readFileSync("src/collections/case/CaseBack.css", "utf8");
  expect(styles).toMatch(/\.collection-case \.kase\s*\{\s*--u: calc\(var\(--ch\) \/ 340\)/);
  expect(inside).toContain("font-size: calc(12 * var(--u))");
  expect(inside).toContain("font: 900 calc(16 * var(--u))");
  expect(back).toContain("font-size: calc(12 * var(--u))");
  expect(back).toContain("-webkit-line-clamp: 7");
  expect(back).toContain("aspect-ratio: 16 / 9");
});
