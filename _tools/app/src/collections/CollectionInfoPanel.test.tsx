import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { CollectionSummary } from "../library/types";
import { CollectionInfoPanel } from "./CollectionInfoPanel";

afterEach(cleanup);

const base = { id: "c1", name: "밤의 도서관", description: null, genres: "Action, Romance, Isekai, action, 판타지" } as unknown as CollectionSummary;

it("shows manga genres (English MangaDex tags) in Korean without duplicates", () => {
  render(<CollectionInfoPanel collection={{ ...base, type: "manga" }} />);
  expect(screen.getByText("액션, 로맨스, 이세계, 판타지")).toBeInTheDocument();
});

it("leaves other Collection types' genres to their own display", () => {
  render(<CollectionInfoPanel collection={{ ...base, type: "game" }} />);
  expect(screen.getByText("Action, Romance, Isekai, action, 판타지")).toBeInTheDocument();
});
