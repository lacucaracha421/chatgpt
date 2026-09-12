import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { AvEditPanel } from "./AvEditPanel";
import type { AvDetails, AvGateway } from "./avTypes";
afterEach(cleanup);
const details: AvDetails = { collectionId: "av", revision: 2, productCode: "CODE", label: null, series: null, people: [
  { id: "person-a", displayName: "동명", role: "performer", order: 0, creditName: null },
  { id: "person-b", displayName: "동명", role: "performer", order: 1, creditName: null },
] };
it("keeps same-name identities and saves role order with the original revision", async () => {
  const user = userEvent.setup(), saveDetails = vi.fn().mockResolvedValue({ ...details, revision: 3 });
  render(<AvEditPanel details={details} api={{ saveDetails, searchPeople: vi.fn() } as unknown as AvGateway} onClose={vi.fn()} onSaved={vi.fn()} />);
  await user.click(screen.getAllByRole("button", { name: "동명 아래로" })[0]);
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saveDetails).toHaveBeenCalledWith("av", expect.objectContaining({ expectedRevision: 2, people: [
    { person: { kind: "existing", id: "person-b" }, role: "performer", creditName: null },
    { person: { kind: "existing", id: "person-a" }, role: "performer", creditName: null },
  ] }));
});
it("retains a draft on stale save and creates people only when explicitly selected", async () => {
  const user = userEvent.setup(), close = vi.fn(), saveDetails = vi.fn().mockRejectedValue({ message: "정보가 변경되었습니다." });
  render(<AvEditPanel details={{ ...details, people: [] }} api={{ saveDetails, searchPeople: vi.fn().mockResolvedValue([{ id: "existing", displayName: "이름" }]) } as unknown as AvGateway} onClose={close} onSaved={vi.fn()} />);
  await user.type(screen.getByRole("textbox", { name: "인물 이름 검색" }), "이름");
  await waitFor(() => expect(screen.getByRole("list", { name: "기존 인물" })).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: "새 인물로 추가" }));
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saveDetails).toHaveBeenCalledWith("av", expect.objectContaining({ people: [{ person: { kind: "new", displayName: "이름" }, role: "performer", creditName: null }] }));
  expect(await screen.findByRole("alert")).toHaveTextContent("정보가 변경"); expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "품번" })).toHaveValue("CODE");
});
