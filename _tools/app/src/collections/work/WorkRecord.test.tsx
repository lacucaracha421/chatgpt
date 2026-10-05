import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollectionSummary, CollectionWorkRecord, CollectionRecordEdit } from "../../library/types";
import { WorkRecordEditor } from "./WorkRecord";

const work = { id: "g", type: "game", createdAt: "2026-01-01", platforms: "Switch 2, PC" } as CollectionSummary;
const record: CollectionWorkRecord = { status: "playing", ownedPlatform: "Switch 2", myScore: 3.5, memo: "kept" };
afterEach(cleanup);
describe("auto-saving personal record", () => {
  it("preserves a stored half and clears it when its selected star is clicked", async () => {
    const save = vi.fn().mockResolvedValue({ ...record, myScore: null });
    const { container } = render(<WorkRecordEditor collection={work} record={record} onSave={save} />);
    const current = screen.getByRole("button", { name: "내 별점 4점" });
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelectorAll('.work-stars button > span')[3]).toHaveStyle({ width: "50%" });
    expect(save).not.toHaveBeenCalled();
    await userEvent.click(current);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ field: "myScore", value: null }));
  });
  it("restores a failed edit with shared error feedback and retries the exact field", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("save failed")).mockResolvedValue({ ...record, myScore: 5 });
    render(<WorkRecordEditor collection={work} record={record} onSave={save} />);
    await userEvent.click(screen.getByRole("button", {name: "내 별점 5점"}));
    expect(await screen.findByRole("alert")).toHaveTextContent("save failed");
    expect(screen.getByRole("button", {name: "내 별점 4점"})).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", {name:"다시 시도"}));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith({field:"myScore",value:5});
    expect(await screen.findByRole("status")).toHaveTextContent("저장됨");
  });
  it("keeps the edited status painted through stale props, saving and acknowledgement", async () => {
    let finish!: (value: CollectionWorkRecord) => void;
    const save = vi.fn(() => new Promise<CollectionWorkRecord>(resolve => { finish = resolve; }));
    const view = render(<WorkRecordEditor collection={work} record={record} onSave={save} />);
    const label = screen.getByRole("button", { name: "상태" });
    const labels: string[] = [label.textContent!];
    const observer = new MutationObserver(() => labels.push(label.textContent!));
    observer.observe(label, { childList: true, characterData: true, subtree: true });
    await userEvent.click(label);
    await userEvent.click(screen.getByRole("menuitemradio", { name: "다 함" }));
    expect(label).toHaveTextContent("다 함");
    // An unrelated metadata read must not replace the pending field with an empty value.
    view.rerender(<WorkRecordEditor collection={work} record={{ ...record, status: null }} onSave={save} />);
    expect(label).toHaveTextContent("다 함");
    await act(async () => finish({ ...record, status: "done" }));
    view.rerender(<WorkRecordEditor collection={work} record={{ ...record, status: "done" }} onSave={save} />);
    expect(screen.getByRole("button", { name: "상태" })).toBe(label);
    expect(label).toHaveTextContent("다 함");
    expect(labels.every(value => value === "하는 중" || value === "다 함")).toBe(true);
    observer.disconnect();
  });
  it.each(["status", "ownedPlatform", "myScore", "memo"] as const)("restores only the failed %s field", async field => {
    let fail!: (error: Error) => void;
    const save = vi.fn(() => new Promise<CollectionWorkRecord>((_resolve, reject) => { fail = reject; }));
    render(<WorkRecordEditor collection={work} record={record} onSave={save} />);
    if (field === "status" || field === "ownedPlatform") {
      await userEvent.click(screen.getByRole("button", { name: field === "status" ? "상태" : "소유 기기" }));
      await userEvent.click(screen.getByRole("menuitemradio", { name: field === "status" ? "다 함" : "PC" }));
    } else if (field === "myScore") await userEvent.click(screen.getByRole("button", { name: "내 별점 5점" }));
    else {
      const memo = screen.getByRole("textbox", { name: "메모" });
      fireEvent.change(memo, { target: { value: "new memo" } }); fireEvent.blur(memo);
    }
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    await act(async () => fail(new Error("저장 실패")));
    expect(screen.getByRole("alert")).toHaveTextContent("저장 실패");
    expect(screen.getByRole("button", { name: "상태" })).toHaveTextContent("하는 중");
    expect(screen.getByRole("button", { name: "소유 기기" })).toHaveTextContent("Switch 2");
    expect(screen.getByRole("button", { name: "내 별점 4점" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "메모" })).toHaveValue("kept");
  });
  it("saves the owned platform from a quiet menu and limits labels by work type", async () => {
    const save = vi.fn().mockResolvedValue({...record,ownedPlatform:"PC"});
    const view=render(<WorkRecordEditor collection={work} record={record} onSave={save}/>);
    await userEvent.click(screen.getByRole("button",{name:"소유 기기"}));
    await userEvent.click(screen.getByRole("menuitemradio",{name:"PC"}));
    await waitFor(()=>expect(save).toHaveBeenCalledWith({field:"ownedPlatform",value:"PC"}));
    view.rerender(<WorkRecordEditor collection={{...work,id:"av",type:"av"}} record={record} onSave={save}/>);
    expect(screen.queryByRole("button",{name:"소유 기기"})).toBeNull();
    await userEvent.click(screen.getByRole("button",{name:"상태"}));
    expect(screen.getByRole("menuitemradio",{name:"다 봄"})).toBeInTheDocument();
    expect(screen.queryByRole("menuitemradio",{name:"하는 중"})).toBeNull();
  });
  it("flushes a closing memo behind its earlier in-flight write", async () => {
    let finish!: (value:CollectionWorkRecord)=>void;
    const calls:CollectionRecordEdit[]=[];
    const save=vi.fn().mockImplementation((edit:CollectionRecordEdit)=>{
      calls.push(edit); return calls.length===1 ? new Promise<CollectionWorkRecord>(resolve=>{finish=resolve;}) : Promise.resolve({...record,memo:"new"});
    });
    const view=render(<WorkRecordEditor collection={work} record={record} onSave={save}/>);
    const memo=screen.getByRole("textbox",{name:"메모"});
    fireEvent.change(memo,{target:{value:"old"}}); fireEvent.blur(memo);
    await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
    fireEvent.change(memo,{target:{value:"new"}});
    view.unmount();
    expect(save).toHaveBeenCalledTimes(1);
    await act(async()=>finish({...record,memo:"old"}));
    await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));
    expect(calls).toEqual([{field:"memo",value:"old"},{field:"memo",value:"new"}]);
  });
});
