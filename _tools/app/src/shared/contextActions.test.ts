import { expect, it, vi } from "vitest";
import { artistActionDefs, bindMenuItems, bindSheetItems, collectionActionDefs, imageActionDefs, treeActionDefs, uniqueSources } from "./contextActions";
import { shelfMoveActionDefs } from "./shelfOrder";

const all = (defs: { id: string }[]) => Object.fromEntries(defs.map(def => [def.id, vi.fn()]));

it("gives the PC folder menu and the tablet sheet one list, and the tablet drops what only the PC does", () => {
  const defs = treeActionDefs({ kind: "folder", hasChildren: false, topLevel: true, pinned: true });
  const handlers = all(defs);
  expect(bindMenuItems(defs, handlers).map(item => item.label))
    .toEqual(["분류함으로 쓰기", "고정 해제", "하위 폴더 만들기", "이름 바꾸기", "아이콘 및 색상", "폴더 이동", "삭제"]);
  expect(bindSheetItems(defs, handlers).map(item => item.label)).toEqual(["고정 해제", "하위 폴더 만들기", "이름 바꾸기", "아이콘 및 색상"]);
});

it("leaves out an item a client has no operation for", () => {
  const defs = treeActionDefs({ kind: "folder", hasChildren: false });
  const handlers = { "create-child": vi.fn(), rename: vi.fn() };
  expect(bindMenuItems(defs, handlers).map(item => item.id)).toEqual(["create-child", "rename"]);
  expect(bindSheetItems(defs, handlers).map(item => item.id)).toEqual(["create-child", "rename"]);
});

it("protects the 오리지널 root and the 마음에 들어요 album, and blocks deleting a place that has children", () => {
  expect(treeActionDefs({ kind: "folder", originalsRoot: true, hasChildren: true }).map(def => def.id)).toEqual(["pin", "create-child", "appearance"]);
  expect(treeActionDefs({ kind: "album", likesAlbum: true, hasChildren: false }).map(def => def.id)).toEqual(["create-child", "rename", "appearance", "move"]);
  const folder = treeActionDefs({ kind: "folder", hasChildren: true }).find(def => def.id === "delete")!;
  expect(folder).toMatchObject({ label: "삭제 — 하위 폴더 있음", disabled: true, danger: true });
  expect(treeActionDefs({ kind: "album", hasChildren: true }).find(def => def.id === "delete")!.label).toBe("삭제 — 하위 앨범 있음");
});

it("offers the album delete on the tablet but not the folder delete", () => {
  const album = treeActionDefs({ kind: "album", hasChildren: false });
  expect(bindSheetItems(album, all(album)).map(item => item.id)).toEqual(["create-child", "rename", "appearance", "delete"]);
});

it("words a collection's delete as 휴지통으로 and flips the showcase item", () => {
  expect(collectionActionDefs({ showcase: false }).map(def => def.label)).toEqual(["편집", "쇼케이스에 추가", "휴지통으로"]);
  expect(collectionActionDefs({ showcase: true })[1]!.label).toBe("쇼케이스에서 빼기");
  expect(collectionActionDefs({ showcase: true }).find(def => def.id === "delete")!.danger).toBe(true);
});

it("keeps merging artists on the PC", () => {
  const defs = artistActionDefs({ pinned: false, hidden: true });
  const handlers = all(defs);
  expect(bindMenuItems(defs, handlers).map(item => item.label)).toEqual(["고정", "이름 바꾸기", "다른 작가와 합치기", "숨김 해제"]);
  expect(bindSheetItems(defs, handlers).map(item => item.label)).toEqual(["고정", "이름 바꾸기", "숨김 해제"]);
});

it("switches image items off when there is nothing to act on and keeps the count a heading", () => {
  const idle = imageActionDefs({ count: 3, busy: false, sourceCount: 0, albumCount: 2 });
  expect(idle.find(def => def.id === "copy-source")!.disabled).toBe(true);
  expect(idle.find(def => def.id === "album")!.disabled).toBe(false);
  expect(imageActionDefs({ count: 3, busy: true, sourceCount: 2, albumCount: 2 }).filter(def => def.disabled).map(def => def.id)).toEqual(["copy-source", "album", "trash"]);
  const handlers = all(idle);
  const menu = bindMenuItems(idle, handlers);
  expect(menu[0]).toMatchObject({ id: "count", label: "3개 선택", disabled: true });
  expect(menu[menu.length - 1]).toMatchObject({ id: "trash", label: "휴지통으로", destructive: true });
  expect(bindSheetItems(idle, handlers).map(item => item.id)).toEqual(["copy-source", "album", "info", "trash"]);
});

it("adds the album and collection removals only where the images are listed", () => {
  const inAlbum = imageActionDefs({ count: 1, busy: false, sourceCount: 1, albumCount: 1, inAlbum: true }).map(def => def.id);
  expect(inAlbum).toContain("remove-album");
  const inCollection = imageActionDefs({ count: 1, busy: false, sourceCount: 1, albumCount: 1, inCollection: true }).map(def => def.id);
  expect(inCollection).toEqual(expect.arrayContaining(["remove", "cover"]));
  expect(imageActionDefs({ count: 2, busy: false, sourceCount: 1, albumCount: 1, inCollection: true }).map(def => def.id)).not.toContain("cover");
});

it("turns a handler with choices into a sub-menu on the PC", () => {
  const run = vi.fn();
  const defs = imageActionDefs({ count: 1, busy: false, sourceCount: 1, albumCount: 1 });
  const item = bindMenuItems(defs, { album: { choices: [{ id: "a", label: "앨범 A", run }] } }).find(entry => entry.id === "album")!;
  item.children![0]!.onSelect();
  expect(run).toHaveBeenCalledOnce();
});

it("disables a shelf card's moves at the ends of its band", () => {
  const first = shelfMoveActionDefs(["a", "b", "c"], "a");
  expect(first.map(def => [def.id, !!def.disabled])).toEqual([["move-prev", true], ["move-next", false], ["move-first", true], ["move-last", false]]);
  expect(shelfMoveActionDefs(["a", "b", "c"], "b", true).every(def => def.disabled)).toBe(true);
});

it("lists each source address once", () => {
  expect(uniqueSources([" https://a ", "https://a", null, undefined, "", "https://b"])).toEqual(["https://a", "https://b"]);
});
