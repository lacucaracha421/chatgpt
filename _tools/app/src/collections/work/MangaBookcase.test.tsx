import { displayDate } from "../../shared/displayDate";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MangaBookcase, type MangaWorkData } from "./MangaBookcase";
import { mangaPixels, MANGA_PX_PER_MM } from "../mangaDimensions";
import * as dimensions from "../mangaDimensions";
import { stripPosition } from "./coverStrip";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const volumes=[1,2,3].map(n=>({id:`v${n}`,volumeNumber:n,editionIndex:0,displayLabel:String(n),coverArtworkId:`a${n}`,localReleaseDate:n===3?"2026-12-01":null,isbn13:null,releaseStatus:n===3?"upcoming" as const:"released" as const}));
const manga:MangaWorkData={volumes,activeVolumeId:"v1",editionIndex:0,focuses:[],ownedNumbers:[1],scope:"",revision:"",ownership:null,management:null};
describe("printed-spine bookcase",()=>{
  it("renders only the old and new picked spine when the selected volume changes", () => {
    const measure = vi.spyOn(dimensions, "mangaPixels");
    const many = Array.from({ length: 115 }, (_, index) => ({ ...volumes[0], id: `m${index}`, volumeNumber: index + 1, displayLabel: String(index + 1) }));
    const data = { ...manga, volumes: many, activeVolumeId: "m0" };
    const view = render(<MangaBookcase manga={data} privacy onPick={() => undefined} />);
    measure.mockClear();
    view.rerender(<MangaBookcase manga={{ ...data, activeVolumeId: "m60" }} privacy onPick={() => undefined} />);
    expect(screen.getByRole("button", { name: "61권 보기" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1권 보기" })).toHaveAttribute("aria-pressed", "false");
    expect(measure).toHaveBeenCalledTimes(2);
  });
  it("lets the page wheel pass over a short row and at the end of a horizontal run", () => {
    // List shelves wrap now; the work-screen strip is the horizontal run.
    const view=render(<MangaBookcase manga={manga} privacy={false} onPick={()=>undefined}/>);
    const track=view.container.querySelector<HTMLElement>(".home-shelf__track")!;
    let width=200;
    Object.defineProperties(track,{clientWidth:{value:200},scrollWidth:{get:()=>width}});
    const wheel=()=>{
      const event=new WheelEvent('wheel',{deltaY:30,bubbles:true,cancelable:true});
      fireEvent(track,event);return event.defaultPrevented;
    };
    expect(wheel()).toBe(false);
    width=800;track.scrollLeft=590;
    expect(wheel()).toBe(true);
    expect(wheel()).toBe(false);
  });

  it("labels only the latest Korean release and preserves its unowned look", () => {
    const view = render(<MangaBookcase manga={{ ...manga, latestKoreanVolume: 2 }} privacy={false} onPick={() => undefined} />);
    const latest = screen.getByRole("button", { name: "2권 보기" });
    expect(latest).toHaveClass("manga-spine--missing");
    expect(within(latest).getByText("최신")).toBeInTheDocument();
    expect(screen.getAllByText("최신")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "3권 보기" })).not.toHaveTextContent("최신");
    view.rerender(<MangaBookcase manga={{ ...manga, latestKoreanVolume: 2, activeVolumeId: "v2" }} privacy={false} onPick={() => undefined} />);
    expect(latest).toHaveAttribute("aria-pressed", "true");
    expect(latest).toHaveClass("manga-spine--missing");
    expect(within(latest).getByText("최신")).toBeInTheDocument();
    view.rerender(<MangaBookcase manga={manga} privacy={false} onPick={() => undefined} />);
    expect(screen.queryByText("최신")).toBeNull();
  });
  it("uses the centre fallback and clamps the cut to the cover edges",()=>{
    expect(stripPosition(null,85,20)).toBe(50);
    expect(stripPosition(.5,85,20)).toBe(50);
    expect(stripPosition(0,85,20)).toBe(0);
    expect(stripPosition(1,85,20)).toBe(100);
    expect(stripPosition(.2,20,30)).toBe(50);
  });
  it("updates the focused strip on the same image element and marks unowned covers",()=>{
    const view=render(<MangaBookcase manga={manga} privacy={false} onPick={()=>undefined}/>);
    const unowned=screen.getByRole("button",{name:"2권 보기"});
    expect(unowned).toHaveClass("manga-spine--missing");
    const image=unowned.querySelector<HTMLImageElement>("img")!;
    Object.defineProperty(image,"naturalWidth",{value:400});Object.defineProperty(image,"naturalHeight",{value:600});fireEvent.load(image);
    expect(image.style.objectPosition).toBe("50% 50%");
    view.rerender(<MangaBookcase manga={{...manga,focuses:[{volumeId:"v2",coverArtworkId:"a2",focusX:.25,method:"head"}]}} privacy={false} onPick={()=>undefined}/>);
    expect(screen.getByRole("button",{name:"2권 보기"}).querySelector("img")).toBe(image);
    expect(image.style.objectPosition).not.toBe("50% 50%");
    expect(screen.getByRole("button",{name:"3권 보기"})).toHaveAttribute("aria-description",`${displayDate("2026-12-01")} 출간 예정`);
  });
  it("keeps each volume thickness stable across works and scrolls the shelf, not the page, to the current volume",()=>{
    const many=Array.from({length:60},(_,i)=>({...volumes[0],id:`m${i+1}`,volumeNumber:i+1,displayLabel:String(i+1),coverArtworkId:`c${i+1}`,localReleaseDate:null,releaseStatus:"released" as const}));
    const view=render(<MangaBookcase manga={{...manga,volumes:many,activeVolumeId:"m1"}} privacy={false} onPick={()=>undefined}/>);
    const first = screen.getByRole("button", { name: "1권 보기" });
    const firstWidth = first.style.getPropertyValue("--spine-width");
    expect(firstWidth).toBe(`${mangaPixels("m1", MANGA_PX_PER_MM.pc).spine}px`);
    view.rerender(<MangaBookcase manga={{...manga,volumes:many.slice().reverse(),activeVolumeId:"m1"}} privacy={false} onPick={()=>undefined}/>);
    expect(first.style.getPropertyValue("--spine-width")).toBe(firstWidth);
    view.rerender(<MangaBookcase manga={{...manga,activeVolumeId:"v1"}} privacy={false} onPick={()=>undefined}/>);
    expect(screen.getByRole("button",{name:"2권 보기"}).style.getPropertyValue("--spine-width")).toBe(`${mangaPixels("v2", MANGA_PX_PER_MM.pc).spine}px`);
    const track=view.container.querySelector<HTMLElement>(".home-shelf__track")!;
    const scrollTo=vi.fn();track.scrollTo=scrollTo;
    track.getBoundingClientRect=()=>({left:0,right:400,width:400,top:0,bottom:184,height:184,x:0,y:0,toJSON:()=>null});
    const third=screen.getByRole("button",{name:"3권 보기"});
    third.getBoundingClientRect=()=>({left:500,right:585,width:85,top:0,bottom:120,height:120,x:500,y:0,toJSON:()=>null});
    view.rerender(<MangaBookcase manga={{...manga,activeVolumeId:"v3"}} privacy={false} onPick={()=>undefined}/>);
    expect(scrollTo).toHaveBeenCalledWith({left:249,behavior:expect.any(String)});
  });
});

// jsdom has no PointerEvent constructor or layout; declare the gesture coordinates.
function pointer(node: HTMLElement, type: string, x: number, y = 8) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "touch" }, isPrimary: { value: true } });
  fireEvent(node, event);
}
function tabletBookcase(touchTargets = true) {
  const onPick = vi.fn();
  const view = render(<MangaBookcase list touchTargets={touchTargets} manga={{ ...manga, activeVolumeId: null }} privacy={false} onPick={onPick} />);
  screen.getAllByRole("button", { name: /권 보기$/ }).forEach((spine, index) => {
    spine.getBoundingClientRect = () => ({ left: 24 + index * 32, width: 30, right: 54 + index * 32, top: 16, bottom: 136, height: 120, x: 24 + index * 32, y: 16, toJSON: () => null });
  });
  return { onPick, track: view.container.querySelector<HTMLElement>(".home-shelf__track")! };
}
describe("tablet book area taps", () => {
  it.each([8, 150])("picks the nearest spine in a gap, above or below the books (y=%s)", y => {
    const { onPick, track } = tabletBookcase();
    pointer(track, "pointerdown", 55.5, y); pointer(track, "pointerup", 55.5, y);
    fireEvent.click(track, { detail: 1 });
    expect(onPick).toHaveBeenCalledExactlyOnceWith("v2");
  });
  it("does not pick after a swipe, even when it returns to the starting point", () => {
    const { onPick, track } = tabletBookcase();
    const spine = screen.getByRole("button", { name: "2권 보기" });
    pointer(spine, "pointerdown", 70); pointer(track, "pointermove", 110); pointer(spine, "pointerup", 70);
    fireEvent.click(spine, { detail: 1 });
    expect(onPick).not.toHaveBeenCalled();
  });
  it("does not pick after scrolling or a cancelled gesture", () => {
    const { onPick, track } = tabletBookcase();
    pointer(track, "pointerdown", 55.5);
    track.scrollLeft = 20; fireEvent.scroll(track); pointer(track, "pointerup", 55.5);
    pointer(track, "pointerdown", 55.5); pointer(track, "pointercancel", 55.5); pointer(track, "pointerup", 55.5);
    expect(onPick).not.toHaveBeenCalled();
  });
  it("picks a direct spine tap once and preserves keyboard activation", () => {
    const { onPick } = tabletBookcase();
    const spine = screen.getByRole("button", { name: "2권 보기" });
    pointer(spine, "pointerdown", 70); pointer(spine, "pointerup", 70); fireEvent.click(spine, { detail: 1 });
    expect(onPick).toHaveBeenCalledExactlyOnceWith("v2");
    fireEvent.click(spine, { detail: 0 }); expect(onPick).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(".manga-shelf-out")).toHaveLength(1);
  });
  it("keeps PC gaps inactive and direct mouse clicks working", () => {
    const { onPick, track } = tabletBookcase(false);
    pointer(track, "pointerdown", 55.5); pointer(track, "pointerup", 55.5);
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "2권 보기" }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith("v2");
  });
});
