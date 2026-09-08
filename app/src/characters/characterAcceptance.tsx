// Isolated browser acceptance entry; not imported by the product.
import { createRoot } from "react-dom/client";
import { CharacterLab } from "./CharacterLab";
import { createCharacterFixture, fixtureAssets, fixtureClassifications } from "./characterFixtures";
import { LibraryProvider } from "../library/LibraryContext";
import type { LibraryGateway } from "../library/types";
import "../styles/tokens.css";
import "../styles/global.css";

const gateway={openLibrary:async()=>({root:"isolated-browser-fixture"}),listAssets:async()=>({items:fixtureAssets,nextCursor:null})} as unknown as LibraryGateway;
createRoot(document.getElementById("root")!).render(<LibraryProvider gateway={gateway}><CharacterLab api={createCharacterFixture()} classifications={fixtureClassifications} initialSeriesId="series" onClose={()=>{ document.getElementById("root")!.textContent="검토 창 닫힘 · 운영 라이브러리는 사용하지 않았습니다."; }} /></LibraryProvider>);
