import { readFileSync } from "node:fs";
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RecordStars } from "../collections/work/WorkRecord";

afterEach(() => { cleanup(); document.head.querySelectorAll("[data-stars-test]").forEach(style => style.remove()); });

// The tablet bundle can load the work screen's star rules after Home's; the shelf must not depend on that order.
it.each([false, true])("keeps one star row on the playing shelf when collectionWork.css loads later (%s)", workLast => {
  const home = readFileSync("src/home/home.css", "utf8"), work = readFileSync("src/collections/work/collectionWork.css", "utf8");
  const style = document.createElement("style"); style.dataset.starsTest = "";
  style.textContent = workLast ? home + work : work + home;
  document.head.append(style);
  const { container } = render(<span className="home-playing__meta"><RecordStars score={3.5} /></span>);
  const star = container.querySelectorAll<HTMLElement>(".work-star")[3]!;
  const fill = star.querySelector<HTMLElement>(":scope > span")!;
  const box = getComputedStyle(star), layer = getComputedStyle(fill);
  // The filled glyph sits exactly over the outline glyph: same box, same alignment.
  expect(box.display).toBe("inline-flex");
  expect(box.height).toBe("var(--icon-sm)");
  expect(box.alignItems).toBe("flex-start");
  expect(layer.position).toBe("absolute");
  expect(layer.top).toBe("0px");
  expect(layer.display).toBe("flex");
  expect(fill.style.width).toBe("50%");
});
