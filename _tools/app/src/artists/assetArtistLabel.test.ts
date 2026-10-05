import {expect, it} from "vitest";
import type {AssetSummary} from "../library/types";
import {getArtistLabel} from "../assets/AssetViewer";

it("uses the assigned artist label in the viewer before creator metadata", () => {
  const asset = {id: "a", creatorName: "Reposter", creatorHandle: "Reposter", title: null, originalName: "file.png"} as AssetSummary;
  expect(getArtistLabel(asset, {label: "Assigned artist"})).toBe("Assigned artist");
  expect(getArtistLabel(asset, null)).toBe("@Reposter");
  expect(getArtistLabel({...asset, creatorName: null, creatorHandle: null}, {label: "HoundShou"})).toBe("HoundShou");
});
