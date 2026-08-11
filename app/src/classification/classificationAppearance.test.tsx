import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_COLORS,
  CLASSIFICATION_ICONS,
  ClassificationIcon,
  classificationColor,
} from "./classificationAppearance";

describe("classification appearance catalog", () => {
  it("provides 24 unique icons and 12 unique colors", () => {
    expect(CLASSIFICATION_ICONS).toHaveLength(24);
    expect(new Set(CLASSIFICATION_ICONS.map(({ key }) => key)).size).toBe(24);
    expect(CLASSIFICATION_COLORS).toHaveLength(12);
    expect(new Set(CLASSIFICATION_COLORS.map(({ key }) => key)).size).toBe(12);
  });

  it("uses the classification kind when no custom icon is selected", () => {
    const { rerender } = render(
      <ClassificationIcon kind="work" iconKey={null} />,
    );
    expect(screen.getByTestId("classification-icon")).toHaveAttribute(
      "data-icon-key",
      "book",
    );

    rerender(<ClassificationIcon kind="tag" iconKey={null} />);
    expect(screen.getByTestId("classification-icon")).toHaveAttribute(
      "data-icon-key",
      "folder",
    );
  });

  it("falls back safely for unknown persisted values", () => {
    const { container } = render(
      <ClassificationIcon kind="tag" iconKey="not-an-icon" />,
    );
    expect(container.querySelector("[data-testid='classification-icon']")).toHaveAttribute(
      "data-icon-key",
      "folder",
    );
    expect(classificationColor("pink")).toBe("#df6fa7");
    expect(classificationColor("not-a-color")).toBe("var(--color-muted)");
    expect(classificationColor(null)).toBe("var(--color-muted)");
  });
});
