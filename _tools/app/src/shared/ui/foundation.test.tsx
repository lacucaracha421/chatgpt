import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SVGProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { Checkbox } from "./Checkbox";
import { EmptyState } from "./EmptyState";
import { Field, TextInput } from "./TextInput";
import { SegmentedControl } from "./SegmentedControl";
import { SectionLabel } from "./SectionLabel";
import { Switch } from "./Switch";
import { Tabs } from "./Tabs";

function Icon(props: SVGProps<SVGSVGElement>) {
  return <svg {...props} />;
}

afterEach(cleanup);

describe("shared foundation controls", () => {
  it("keeps checkbox labels and switch semantics accessible", () => {
    render(
      <>
        <Checkbox label="Remember this" />
        <Switch label="Sync now" description="Runs after the next refresh" />
        <Checkbox aria-label="Select all" />
      </>,
    );

    expect(screen.getByRole("checkbox", { name: "Remember this" })).toHaveClass("ui-checkbox");
    expect(screen.getByRole("switch", { name: "Sync now" })).toHaveClass("ui-switch");
    expect(screen.getByText("Runs after the next refresh")).toHaveClass("ui-choice__description");
    expect(screen.getByRole("checkbox", { name: "Select all" })).toBeInTheDocument();
  });

  it("wires Field errors to its TextInput", () => {
    render(
      <Field label="Title" error="Title is required">
        <TextInput />
      </Field>,
    );

    const input = screen.getByRole("textbox");
    const error = screen.getByRole("alert");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", error.id);
    expect(error).toHaveTextContent("Title is required");
  });

  it("requires and exposes an accessible name for an icon-only Badge", () => {
    render(<Badge icon={Icon} aria-label="Pinned" />);

    const badge = screen.getByRole("img", { name: "Pinned" });
    expect(badge).toHaveClass("ui-badge", "ui-badge--plain", "ui-badge--icon");
  });

  it("renders SectionLabel content, actions, and its open button", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<SectionLabel title="작품" count={12} actions={<button type="button">필터</button>} onOpen={onOpen} />);

    expect(screen.getByText("작품")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "필터" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "작품 전체" }));

    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("renders an optional EmptyState icon", () => {
    render(<EmptyState title="비어 있음" icon={(props) => <Icon {...props} data-testid="empty-icon" />} />);

    expect(screen.getByTestId("empty-icon")).toHaveClass("ui-empty-state__icon");
    expect(screen.getByText("비어 있음")).toBeInTheDocument();
  });

  it("adds the quiet Button variant", () => {
    render(<Button variant="quiet">More</Button>);
    expect(screen.getByRole("button", { name: "More" })).toHaveClass("ui-button", "ui-button--quiet");
  });

  it("uses radio semantics and arrow navigation for SegmentedControl", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="View"
        options={[{ value: "list", label: "List" }, { value: "grid", label: "Grid" }]}
        value="list"
        onChange={onChange}
      />,
    );

    const list = screen.getByRole("radio", { name: "List" });
    expect(screen.getByRole("radiogroup", { name: "View" })).toBeInTheDocument();
    expect(list).toHaveAttribute("aria-checked", "true");
    list.focus();
    await user.keyboard("{ArrowRight}");

    expect(onChange).toHaveBeenCalledWith("grid");
    expect(screen.getByRole("radio", { name: "Grid" })).toHaveFocus();
  });

  it("uses tab semantics, counts, and arrow navigation for Tabs", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Tabs
        label="Library sections"
        tabs={[{ value: "all", label: "All", count: 4 }, { value: "saved", label: "Saved" }]}
        value="all"
        onChange={onChange}
      />,
    );

    const all = screen.getByRole("tab", { name: "All 4" });
    expect(screen.getByRole("tablist", { name: "Library sections" })).toBeInTheDocument();
    expect(all).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("4")).toHaveClass("ui-tabs__count");
    all.focus();
    await user.keyboard("{ArrowRight}");

    expect(onChange).toHaveBeenCalledWith("saved");
    expect(screen.getByRole("tab", { name: "Saved" })).toHaveFocus();
  });
});
