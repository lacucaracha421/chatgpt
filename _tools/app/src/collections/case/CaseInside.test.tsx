import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CaseInside, CaseScore, type CasePerson } from "./CaseInside";
import { insideFacts, insideRecord } from "../work/WorkInfo";
import { recordStates } from "../work/WorkRecord";
import { AvPortrait } from "../av/AvPortrait";
import type { CollectionSummary } from "../../library/types";

afterEach(cleanup);
const game = { type: "game", name: "Manual title", developer: "Developer", publisher: "Publisher", releaseDate: "2025-01-02" } as CollectionSummary;
const record = { status: "playing", myScore: 4, ownedPlatform: null, memo: "Not printed" };
const cast = (count: number): CasePerson[] => Array.from({ length: count }, (_, index) => ({ id: String(index), name: `Performer ${index + 1}`, role: "performer", order: index }));

describe("CaseInside booklet", () => {
  it.each(["game", "movie", "av"] as const)("prints the %s editor's real status choices and fills only the current one", type => {
    const states = recordStates[type]!;
    const collection = { ...game, type };
    const { container } = render(<CaseInside title={game.name} type={type} record={insideRecord(collection, { ...record, status: states[0]![0] })} facts={insideFacts(collection, null)} />);
    expect([...container.querySelectorAll(".case-status-box")].map(node => node.getAttribute("data-status"))).toEqual(states.map(([id]) => id));
    expect([...container.querySelectorAll(".case-status-box")].map(node => node.textContent)).toEqual(states.map(([, label]) => label));
    expect(container.querySelectorAll(".case-status-box.is-filled")).toHaveLength(1);
    expect(screen.getByRole("img", { name: `${states[0]![1]}: 선택됨` })).toHaveAttribute("data-status", states[0]![0]);
  });
  it("prints the title, blank platform line, score, footer and two clips with a hero cover", () => {
    const { container, rerender } = render(<CaseInside title={game.name} type="game" record={insideRecord(game, record)} facts={insideFacts(game, null)} hero="/hero" front="/front" />);
    expect(screen.getByText(game.name)).toBeInTheDocument();
    expect(screen.getByText("취급 설명서")).toBeInTheDocument();
    expect(container.querySelectorAll(".case-tab")).toHaveLength(2);
    expect(container.querySelectorAll(".case-staple")).toHaveLength(2);
    expect(container.querySelector(".case-manual-form")).toHaveTextContent("상태");
    expect(container.querySelector(".case-writing-line")).toHaveAttribute("aria-label", "미입력");
    expect(screen.getByRole("img", { name: "별점 4" })).toHaveTextContent("☆★☆★☆★☆★☆★");
    expect(container.querySelector(".case-manual-footer")).toHaveTextContent("Developer · Publisher");
    expect(container.querySelector(".case-manual-footer")).toHaveTextContent("2025.1.2");
    expect(container.querySelector<HTMLElement>(".case-manual-cover")!.style.backgroundImage).toContain("/hero");
    expect(screen.queryByText(record.memo)).not.toBeInTheDocument();
    rerender(<CaseInside title={game.name} type="game" record={insideRecord(game, { ...record, ownedPlatform: "PS5" })} facts={[]} front="/front" />);
    expect(screen.getByText("PS5")).toBeInTheDocument();
    expect(container.querySelector(".case-writing-line")).toBeNull();
    expect(container.querySelector<HTMLElement>(".case-manual-cover")!.style.backgroundImage).toContain("/front");
  });
  it("leaves all status boxes empty when no status is recorded and preserves a half score", () => {
    const { container } = render(<CaseInside title="Unrecorded" type="game" record={insideRecord(game, { ...record, status: null, myScore: 3.5 })} facts={[]} />);
    expect(container.querySelectorAll(".case-status-box.is-filled")).toHaveLength(0);
    expect(screen.getByRole("img", { name: "별점 3.5" }).querySelectorAll<HTMLElement>(":scope > span > span")[3]).toHaveStyle({ width: "50%" });
  });
  it("prints a film's director, release and runtime without a device row", () => {
    const film: CollectionSummary = { ...game, type: "movie", director: "Film director", runtimeMinutes: 123 };
    const { container } = render(<CaseInside title="Film" type="movie" record={insideRecord(film, { ...record, status: "watching" })} facts={insideFacts(film, null)} />);
    expect(screen.queryByText("기기")).toBeNull();
    expect(container.querySelector(".case-manual-footer")).toHaveTextContent("Film director2025.1.2123분");
    expect(screen.getByRole("img", { name: "보는 중: 선택됨" })).toBeInTheDocument();
  });
  it("prints the AV code, maker, label/release/runtime and watched record", () => {
    const av: CollectionSummary = { ...game, type: "av", runtimeMinutes: 120 };
    const facts = insideFacts(av, { productCode: "ABC-123", maker: "Maker", label: "Label", releaseDate: "2025-02-03", genres: [] });
    const { container } = render(<CaseInside title="AV" type="av" record={insideRecord(av, { ...record, status: "watched" })} facts={facts} />);
    expect(container.querySelector(".case-av-code")).toHaveTextContent("ABC-123");
    expect(container.querySelector(".case-booklet-subtitle")).toHaveTextContent("Maker");
    expect([...container.querySelectorAll(".case-av-rows dt")].map(node => node.textContent)).toEqual(["레이블", "발매", "수록"]);
    expect(container.querySelector(".case-av-rows")).toHaveTextContent("레이블Label발매2025.2.3수록120분");
    expect(within(container.querySelector<HTMLElement>(".case-av-record")!).getByRole("img", { name: "다 봄: 선택됨" })).toBeInTheDocument();
  });
  it.each([0, 1, 2, 3, 5])("prints %i performers with centred small casts and an overflow card", count => {
    const people = [...cast(count).reverse(), { id: "director", name: "Director", role: "director" as const, order: 0 }];
    const { container } = render(<CaseInside title="AV" type="av" record={[]} facts={[]} people={people} />);
    expect(container.querySelectorAll(".case-pola")).toHaveLength(Math.min(count, 3));
    expect(container.querySelector(".case-director")).toHaveTextContent("감독 · Director");
    if (count > 0) {
      expect(container.querySelector(".case-cast")).toHaveAttribute("data-count", String(Math.min(count, 3)));
      expect(container.querySelector(".case-pola-name")).toHaveTextContent("Performer 1");
      expect(container.querySelector(".case-pola-photo")).toHaveAttribute("aria-hidden", "true");
      expect(screen.queryByRole("img", { name: "Performer 1 사진 없음" })).toBeNull();
    }
    if (count === 3) expect(screen.getByText("Performer 3")).toBeInTheDocument();
    if (count === 5) {
      expect(screen.getByText("+3")).toBeInTheDocument();
      expect(screen.queryByText("Performer 3")).toBeNull();
    }
  });
  it("uses the performer portrait's stored crop inside the frame", () => {
    const portrait = <AvPortrait portrait={{ kind: "crop", artworkId: "art", revision: "r2", rect: { x: .25, y: .1, w: .5, h: .5 } }} name="Performer 1" size="performer" />;
    const { container } = render(<CaseInside title="AV" type="av" record={[]} facts={[]} people={[{ ...cast(1)[0]!, portrait }]} />);
    const crop = container.querySelector<HTMLElement>(".case-pola-photo .av-portrait__crop")!;
    expect(crop.style.backgroundSize).toBe("200% 200%");
    expect(crop.style.backgroundPosition).toBe("50% 20%");
    expect(crop.style.backgroundImage).toContain("art");
    expect(crop.style.backgroundImage).toContain("r2");
    expect(crop.closest('.case-pola-photo')).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("img", { name: /Performer 1/ })).toBeNull();
  });
  it.each(["game", "movie", "av"])("masks the entire %s inside before rendering artwork or cast", type => {
    const { container } = render(<CaseInside title="Secret" type={type} privacy hero="/secret-hero" front="/secret-front" record={[["별점", <CaseScore score={5} />]]} facts={[["품번", "SECRET-123"]]} people={[{ ...cast(1)[0]!, portrait: <img src="/secret-person" alt="Secret person" /> }]} />);
    expect(screen.getByLabelText("비공개 모드")).toBeInTheDocument();
    expect(container.querySelector("img, .case-manual, .case-av-book, .case-cast")).toBeNull();
    expect(container.textContent).toBe("");
  });
});
