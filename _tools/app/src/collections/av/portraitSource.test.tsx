import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { AvPerformerProfile, AvPortrait as PortraitData } from "../avTypes";
import { defaultPortraitSource } from "./portraitSource";
import { AvPortrait } from "./AvPortrait";

afterEach(cleanup);
const profile = { status: "matched", images: [{ id: "p", url: "https://stashdb.org/images/p", width: 300, height: 400 }] } as AvPerformerProfile;
it("prefers an explicit photo, then StashDB, then the existing cover fallback", () => {
  for (const kind of ["crop", "commons", "stashdb"] as const) {
    expect(defaultPortraitSource({ kind } as PortraitData, profile, true)).toBe(kind);
  }
  expect(defaultPortraitSource(null, profile, true)).toBe("stashdb");
  expect(defaultPortraitSource(null, profile, false)).toBe("crop");
  expect(defaultPortraitSource(null, { ...profile, status: "ambiguous" }, true)).toBe("crop");
  expect(defaultPortraitSource(null, { ...profile, images: [] }, true)).toBe("crop");
});

it("falls back to initials when the default StashDB photo cannot load", () => {
  render(<AvPortrait name="Performer" portrait={{ kind: "stashdb", dataUrl: "https://stashdb.org/images/p", width: 300, height: 400, sourceUrl: "https://stashdb.org/images/p" }} size="performer"/>);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByLabelText("Performer 이니셜")).toHaveTextContent("P");
  expect(screen.queryByRole("img")).toBeNull();
});

it("keeps multiple performer photos in bounded grid tracks rather than absolute layers", () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("src/collections/av/avPortrait.css", "utf8") + readFileSync("src/collections/av/avPortraitPicker.css", "utf8");
  document.head.append(style);
  try {
    const portrait = { kind: "stashdb", dataUrl: "data:image/jpeg;base64,eA==", width: 300, height: 400, sourceUrl: "https://stashdb.org/images/p" } as const;
    const { container } = render(<><div className="av-portrait-picker__stashdb-grid">{[1, 2, 3].map(id => <button key={id}><img src={portrait.dataUrl} alt=""/><small>{id}</small></button>)}</div>{[1, 2].map(id => <AvPortrait key={id} portrait={portrait} name={`Performer ${id}`} size="performer"/>)}</>);
    expect(getComputedStyle(container.querySelector(".av-portrait-picker__stashdb-grid")!).display).toBe("grid");
    for (const image of container.querySelectorAll("img")) expect(getComputedStyle(image).position).toBe("static");
    for (const button of container.querySelectorAll("button")) {
      expect(getComputedStyle(button).position).toBe("relative");
      expect(getComputedStyle(button).gridTemplate).toBe("minmax(0, 1fr) / minmax(0, 1fr)");
    }
  } finally { style.remove(); }
});
