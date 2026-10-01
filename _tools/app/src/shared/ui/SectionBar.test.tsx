import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SectionBar } from "./SectionBar";

afterEach(cleanup);

const options = [{ value: "game", label: "게임" }, { value: "av", label: "AV", count: 3, ariaLabel: "AV, 받은 품번 3개" }] as const;

it("lays out the sections and the trailing controls in one bar", () => {
  const { container } = render(<SectionBar label="유형" options={options} value="game" onChange={vi.fn()} trailing={<button type="button">정렬</button>} />);
  const bar = container.firstElementChild as HTMLElement;
  expect(bar).toHaveClass("ui-section-bar", "ui-section-bar--pinned");
  expect([...bar.children].map(child => child.className)).toEqual(["ui-segmented", "ui-section-bar__trailing"]);
  expect(bar.querySelector(".ui-section-bar__trailing")).toContainElement(screen.getByRole("button", { name: "정렬" }));
});

it("takes the host's placement and leaves out an empty trailing slot", () => {
  const { container } = render(<SectionBar label="유형" options={options} value="game" onChange={vi.fn()} placement="inline" className="host-bar" />);
  const bar = container.firstElementChild as HTMLElement;
  expect(bar).toHaveClass("ui-section-bar", "ui-section-bar--inline", "host-bar");
  expect(bar.querySelector(".ui-section-bar__trailing")).toBeNull();
});

it("names a counted section by its own label and changes the section", async () => {
  const onChange = vi.fn();
  render(<SectionBar label="유형" options={options} value="game" onChange={onChange} />);
  const av = screen.getByRole("radio", { name: "AV, 받은 품번 3개" });
  expect(av.querySelector(".ui-segmented__label .ui-segmented__count")).toHaveTextContent("3");
  await userEvent.click(av);
  expect(onChange).toHaveBeenCalledWith("av");
});

it("spreads the sections across the bar and hands the host its element", () => {
  let element: HTMLDivElement | null = null;
  const { container } = render(<SectionBar label="유형" options={options} value="game" onChange={vi.fn()} placement="inline" fullWidth ref={(node) => { element = node; }} />);
  expect(element).toBe(container.firstElementChild);
  expect(screen.getByRole("radiogroup", { name: "유형" })).toHaveClass("ui-segmented--full-width");
});
