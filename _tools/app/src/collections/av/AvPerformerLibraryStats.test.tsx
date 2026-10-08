import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AvPerformerLibraryStats } from "./AvPerformerLibraryStats";

afterEach(cleanup);

it("labels release ranges and appends a rounded average only when scored", () => {
  const { rerender } = render(<AvPerformerLibraryStats workCount={2} soloCount={1} firstRelease="2000-09-09" lastRelease="2001-10-10" averageScore={3.75} />);
  expect(screen.getByLabelText("내 서재 통계")).toHaveTextContent(/^내 작품 2편 · 단독 1 · 발매 2000.9.9–2001.10.10 · 평균 ★3.8$/);
  rerender(<AvPerformerLibraryStats workCount={1} soloCount={1} firstRelease="2000-09-09" lastRelease="2000-09-09" averageScore={null} />);
  expect(screen.getByLabelText("내 서재 통계")).toHaveTextContent(/^내 작품 1편 · 단독 1 · 발매 2000.9.9$/);
});

it("omits missing dates and scores, preserves a single endpoint and a zero score", () => {
  const { rerender } = render(<AvPerformerLibraryStats workCount={0} soloCount={0} firstRelease={null} lastRelease={null} averageScore={null} />);
  expect(screen.getByLabelText("내 서재 통계")).toHaveTextContent(/^내 작품 0편 · 단독 0$/);
  rerender(<AvPerformerLibraryStats workCount={1} soloCount={1} firstRelease={null} lastRelease="2000-09-09" averageScore={0} />);
  expect(screen.getByLabelText("내 서재 통계")).toHaveTextContent(/^내 작품 1편 · 단독 1 · 발매 2000.9.9 · 평균 ★0.0$/);
});
