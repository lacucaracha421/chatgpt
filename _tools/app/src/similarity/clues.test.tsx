import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { SimilarityClues } from "./SimilarityClues";
import { EMPTY_CLUES, reasonSentence, type ClueSideData, type ClueKey } from "./clues";
afterEach(cleanup);
const a: ClueSideData = {handle:"@one",host:"x.com",role:"unknown",postedAt:null,width:1200,height:1600,byteSize:1000,format:"PNG"};
const b: ClueSideData = {...a,handle:"@two",role:"artist"};
it.each([
  ["account", "작가 계정에 올라온 B를 권장합니다."],
  ["posted", "먼저 올라온 B를 권장합니다."],
  ["resolution", "해상도가 더 큰 B를 권장합니다."],
  ["bytes", "파일이 더 큰 B를 권장합니다."],
] as [ClueKey,string][])('explains the deciding %s clue', (reason, expected) => {
  expect(reasonSentence(reason,{...EMPTY_CLUES,[reason]:"b"},["A","B"],[a,b])).toBe(expected);
});
it('explains an unknown account beating a reposter, a same-account resolution, and a tie', () => {
  expect(reasonSentence("account",{...EMPTY_CLUES,account:"a"},["A","B"],[a,{...b,role:"reposter"}])).toBe("퍼온 계정이 아닌 A를 권장합니다.");
  expect(reasonSentence("resolution",{...EMPTY_CLUES,resolution:"b"},["A","B"],[a,{...b,handle:"@ONE"}])).toBe("같은 계정이라 해상도가 더 큰 B를 권장합니다.");
  expect(reasonSentence(null,EMPTY_CLUES,["A","B"],[a,b])).toBe("단서가 같거나 없어 권장하지 않습니다.");
});
it('shows the server favoured side, the deciding row and accessible side names', () => {
  render(<SimilarityClues names={["A","B"]} sides={[a,b]} clues={{...EMPTY_CLUES,account:"b",posted:"a"}} reason="account"/>);
  const account=screen.getByRole("rowheader",{name:/계정.*B 쪽/}).closest("tr")!;
  expect(account).toHaveAttribute("data-deciding");
  expect(account.querySelector('[data-favoured]')).toHaveTextContent("@two");
  expect(account.querySelector('[data-other]')).toHaveTextContent("@one");
  expect(screen.getByRole("columnheader",{name:/B.*권장/})).toBeInTheDocument();
});
it('renders older feeds without inventing clue favours', () => {
  const {container}=render(<SimilarityClues names={["A","B"]} sides={[a,b]} recommended="a"/>);
  expect(container.querySelectorAll('[data-favoured], [data-deciding]')).toHaveLength(0);
  expect(screen.getByRole("columnheader",{name:/A.*권장/})).toBeInTheDocument();
});
