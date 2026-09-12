import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CollectionExhibition, exhibitionPage } from "./CollectionExhibition";
afterEach(cleanup);
it.each([[1,3,1],[9,3,1],[10,4,1],[16,4,1],[17,4,2],[32,4,2]])("exhibits %i works in %i columns with %i pages",(count,columns,pages)=>{
  expect(exhibitionPage(count)).toMatchObject({columns,pages,page:0});
});
it("never silently drops selected works beyond sixteen",async()=>{
  const items=Array.from({length:20},(_,i)=>i+1),onPageChange=vi.fn();
  const renderItem=(item:number)=><button key={item}>{`작품 ${item}`}</button>;
  const view=render(<CollectionExhibition items={items} page={0} onPageChange={onPageChange} render={renderItem} />);
  expect(screen.getAllByRole("button",{name:/작품/})).toHaveLength(16);
  await userEvent.click(screen.getByRole("button",{name:"다음 전시 페이지"}));expect(onPageChange).toHaveBeenCalledWith(1);
  view.rerender(<CollectionExhibition items={items} page={1} onPageChange={onPageChange} render={renderItem} />);
  expect(screen.getAllByRole("button",{name:/작품/})).toHaveLength(4);expect(screen.getByText("작품 20")).toBeInTheDocument();
  expect(exhibitionPage(9,1).page).toBe(0);
});
