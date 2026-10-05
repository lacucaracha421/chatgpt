import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SparklesIcon } from "@heroicons/react/24/outline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge, CountBadge } from "./Badge";
import { DDay } from "./DDay";
import { EmptyState } from "./EmptyState";
import { SectionLabel } from "./SectionLabel";
import { Skeleton } from "./Skeleton";

afterEach(cleanup);

describe("Badge and CountBadge", () => {
  it.each(["plain", "accent", "danger", "count", "scrim", "corner"] as const)("renders the %s variant on the shared class", (variant) => {
    render(<Badge variant={variant}>3</Badge>);
    expect(screen.getByText("3")).toHaveClass("ui-badge", `ui-badge--${variant}`);
  });

  it("formats counts with separators, units and an optional cap", () => {
    const { rerender } = render(<CountBadge value={1284} />);
    expect(screen.getByText("1,284")).toHaveClass("ui-badge--count");
    rerender(<CountBadge value={23} unit="장" variant="scrim" />);
    expect(screen.getByText("23장")).toHaveClass("ui-badge--scrim");
    rerender(<CountBadge value={120} max={99} variant="corner" />);
    expect(screen.getByText("99+")).toHaveClass("ui-badge--corner");
    rerender(<CountBadge value={99} max={99} variant="corner" />);
    expect(screen.getByText("99")).toBeInTheDocument();
  });

  it("names an icon-only badge as an image", () => {
    render(<Badge icon={SparklesIcon} aria-label="추천" />);
    expect(screen.getByRole("img", { name: "추천" })).toHaveClass("ui-badge--icon");
  });
});

describe("DDay", () => {
  it("reads 오늘 on the day as the accent badge and D-n before it", () => {
    const { rerender } = render(<DDay days={0} />);
    expect(screen.getByText("오늘")).toHaveClass("ui-badge", "ui-badge--accent", "ui-dday");
    rerender(<DDay days={3} />);
    expect(screen.getByText("D-3")).toHaveClass("ui-badge--plain", "ui-dday");
  });

  it("renders nothing once the day has passed or is unknown", () => {
    for (const days of [-1, null, undefined, Number.NaN]) {
      const { container } = render(<DDay days={days} />);
      expect(container).toBeEmptyDOMElement();
      cleanup();
    }
  });

  it("has a quiet text form beside date headings", () => {
    render(<DDay as="text" days={40} />);
    const label = screen.getByText("D-40");
    expect(label.tagName).toBe("SPAN");
    expect(label).toHaveClass("ui-dday");
    expect(label).not.toHaveClass("ui-badge");
  });
});

describe("EmptyState", () => {
  it("shows the title, one hint and one action", async () => {
    const onClick = vi.fn();
    render(<EmptyState icon={SparklesIcon} title="검색 결과 없음" hint="검색어나 필터를 바꿔 보세요." action={<button type="button" onClick={onClick}>필터 초기화</button>} />);
    expect(screen.getByRole("heading", { name: "검색 결과 없음" })).toBeInTheDocument();
    expect(screen.getByText("검색어나 필터를 바꿔 보세요.")).toHaveClass("ui-empty-state__hint");
    await userEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("leaves out a false hint and keeps children after it", () => {
    const { container } = render(<EmptyState title="휴지통이 비어 있습니다" hint={false}><p>child</p></EmptyState>);
    expect(container.querySelector(".ui-empty-state__hint")).toBeNull();
    expect(screen.getByText("child")).toBeInTheDocument();
  });

  it("has a one-line inline form for lists, pickers and palettes", () => {
    render(<EmptyState inline role="status" className="ledger-empty" title="기록 없음" />);
    const line = screen.getByRole("status");
    expect(line.tagName).toBe("P");
    expect(line).toHaveClass("ui-empty-state--inline", "ledger-empty");
    expect(line).toHaveTextContent("기록 없음");
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("SectionLabel", () => {
  it("adds a tabular count with its unit, an optional icon and the open button", async () => {
    const onOpen = vi.fn();
    const { container } = render(<SectionLabel title="1년 전 오늘" count={1284} unit="장" icon={SparklesIcon} onOpen={onOpen} />);
    expect(container.querySelector(".ui-section-label__count")).toHaveTextContent("1,284장");
    expect(container.querySelector(".ui-section-label__title svg")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "1년 전 오늘 전체" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
  it("reads the count as a separate word", () => {
    render(<SectionLabel as="h2" title="시즌" count={1} unit="개" />);
    expect(screen.getByRole("heading", { name: "시즌 1개" })).toBeInTheDocument();
  });
});

describe("Skeleton", () => {
  it("announces one placeholder and hides decorative siblings", () => {
    const { container } = render(<><Skeleton label="작가 목록" /><Skeleton label={null} /></>);
    expect(screen.getByRole("status", { name: "작가 목록" })).toHaveClass("ui-skeleton");
    expect(container.querySelectorAll(".ui-skeleton")[1]).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
