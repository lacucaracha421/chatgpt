import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { workFacts } from "./workFacts";

it("shows an AV work's stored genres by Korean name and leaves sale and distribution tags out", () => {
  const rows = workFacts({ type: "av" }, { genres: ["痴女", "セール対象商品", "ギリモザ", "ハイビジョン"], productCode: "ABC-123" });
  const tags = rows.find(([label]) => label === "태그")!;
  render(<>{tags[1]}</>);
  expect(screen.getAllByText(/./).map(node => node.textContent)).toEqual(["치녀", "ギリモザ"]);
});

it("shows no tag row when every stored genre is hidden", () => {
  expect(workFacts({ type: "av" }, { genres: ["セール対象商品"], productCode: "ABC-123" }).some(([label]) => label === "태그")).toBe(false);
});
