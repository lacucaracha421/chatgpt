import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MangaBookcase, MANGA_SPINE_WIDTH, type MangaWorkData } from "./MangaBookcase";
import { stripPosition } from "./coverStrip";
afterEach(cleanup);
const volumes=[1,2,3].map(n=>({id:`v${n}`,volumeNumber:n,editionIndex:0,displayLabel:String(n),coverArtworkId:`a${n}`,localReleaseDate:n===3?"2026-12-01":null,isbn13:null,releaseStatus:n===3?"upcoming" as const:"released" as const}));
const manga:MangaWorkData={volumes,activeVolumeId:"v1",editionIndex:0,focuses:[],ownedNumbers:[1],scope:"",revision:"",ownership:null,management:null};
describe("accepted cover-strip bookcase",()=>{
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
    expect(screen.getByRole("button",{name:"3권 보기"})).toHaveAttribute("aria-description","2026-12-01 출간 예정");
  });
  it("gives every work the same spine width and scrolls the shelf, not the page, to the current volume",()=>{
    const many=Array.from({length:60},(_,i)=>({...volumes[0],id:`m${i+1}`,volumeNumber:i+1,coverArtworkId:`c${i+1}`,localReleaseDate:null,releaseStatus:"released" as const}));
    const view=render(<MangaBookcase manga={{...manga,volumes:many,activeVolumeId:"m1"}} privacy={false} onPick={()=>undefined}/>);
    const widths=new Set(screen.getAllByRole("button",{name:/권 보기$/}).map(spine=>spine.style.getPropertyValue("--spine-width")));
    expect([...widths]).toEqual([`${MANGA_SPINE_WIDTH}px`]);
    view.rerender(<MangaBookcase manga={{...manga,activeVolumeId:"v1"}} privacy={false} onPick={()=>undefined}/>);
    expect(screen.getByRole("button",{name:"2권 보기"}).style.getPropertyValue("--spine-width")).toBe(`${MANGA_SPINE_WIDTH}px`);
    const track=view.container.querySelector<HTMLElement>(".home-shelf__track")!;
    const scrollTo=vi.fn();track.scrollTo=scrollTo;
    track.getBoundingClientRect=()=>({left:0,right:400,width:400,top:0,bottom:184,height:184,x:0,y:0,toJSON:()=>null});
    const third=screen.getByRole("button",{name:"3권 보기"});
    third.getBoundingClientRect=()=>({left:500,right:585,width:85,top:0,bottom:120,height:120,x:500,y:0,toJSON:()=>null});
    view.rerender(<MangaBookcase manga={{...manga,activeVolumeId:"v3"}} privacy={false} onPick={()=>undefined}/>);
    expect(scrollTo).toHaveBeenCalledWith({left:249,behavior:expect.any(String)});
  });
});
