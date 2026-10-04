import type { CollectionSummary } from "../../library/types";
import type { AvDetails } from "../avTypes";
import { displayDate } from "../../shared/displayDate";
import { Badge } from "../../shared/ui/Badge";
import type { Fact } from "../case/CollectionCase";
import { displayGenres } from "../displayGenres";

/* A work's fact rows (작품 정보 and the case's inside card), as plain data rules shared by the PC and the tablet. */

/** The fields the fact rows read, as plain data so the tablet's published summary fits too. */
export type WorkFactSource = Pick<CollectionSummary, "type"> & Partial<Pick<CollectionSummary, "releaseDate" | "director" | "productionCompany" | "runtimeMinutes" | "genres" | "author" | "year" | "publisher" | "developer" | "platforms">>;
export type WorkFactAv = Pick<AvDetails, "genres"> & Partial<Pick<AvDetails, "productCode" | "maker" | "label" | "releaseDate">>;
export function workFacts(collection: WorkFactSource, av: WorkFactAv | null, badges = true): Fact[] {
  const rows = collection.type === "av" ? [
    ["품번", av?.productCode], ["메이커", av?.maker], ["레이블", av?.label],
    ["발매", displayDate(av?.releaseDate || collection.releaseDate)], ["태그", av?.genres.join(" · ")],
  ] : collection.type === "movie" ? [["감독", collection.director], ["제작사", collection.productionCompany], ["개봉", displayDate(collection.releaseDate)], ["러닝타임", collection.runtimeMinutes ? `${collection.runtimeMinutes}분` : null], ["장르", displayGenres(collection.genres)]] : collection.type === "manga" ? [["작가", collection.author], ["연도", collection.year?.toString()], ["출판사", collection.publisher], ["발매", displayDate(collection.releaseDate)]] : [["개발사", collection.developer], ["배급사", collection.publisher], ["발매", displayDate(collection.releaseDate)], ["플랫폼", collection.platforms], ["장르", displayGenres(collection.genres)]];
  return rows.filter(row => Boolean(row[1])).map(([label, value]) => [label!, badges && (label === "장르" || label === "태그") ? <span className="work-badges">{(label === "태그" ? av?.genres ?? [] : String(value).split(/\s*[,·]\s*/)).map((genre, index) => <Badge key={`${genre}/${index}`}>{genre}</Badge>)}</span> : value!] as Fact);
}
/** The back uses the info panel's localization, with compact printed labels. */
export function backFacts(collection: WorkFactSource, av: WorkFactAv | null): Fact[] {
  const labels: Record<string, string> = collection.type === "av"
    ? { 품번: "품번", 메이커: "메이커", 레이블: "레이블", 발매: "발매" }
    : collection.type === "movie" ? { 감독: "감독", 제작사: "제작", 개봉: "개봉", 장르: "장르" }
    : { 개발사: "개발", 배급사: "배급", 발매: "발매", 장르: "장르" };
  return workFacts(collection, av, false).filter(([label]) => labels[label]).map(([label, value]) => [labels[label]!, value]);
}
export function insideFacts(collection: WorkFactSource, av: WorkFactAv | null): Fact[] {
  const labels = collection.type === "av" ? ["품번", "메이커", "레이블", "발매"] : collection.type === "movie" ? ["감독", "개봉", "러닝타임"] : ["개발사", "배급사", "발매"];
  const rows = workFacts(collection, av).filter(([label]) => labels.includes(label));
  if (collection.type === "av" && collection.runtimeMinutes) rows.push(["수록", `${collection.runtimeMinutes}분`]);
  return rows;
}
/** The rows after the main facts: 원제, an AV series, a game's length, a series' airing state, the external score. */
export function moreWorkFacts(collection: Pick<CollectionSummary, "type"> & Partial<Pick<CollectionSummary, "originalTitle" | "runtimeMinutes" | "externalScore">>, av: { series?: string | null } | null, series: { status?: string | null; lastAirDate?: string | null } | null): Fact[] {
  return ([
    ["원제", collection.originalTitle], ["시리즈", av?.series], ["수록", collection.type !== "movie" && collection.runtimeMinutes ? `${collection.runtimeMinutes}분` : null],
    ...(series ? [["방영 상태", series.status], ["최근 방영", displayDate(series.lastAirDate)]] : []),
    ["외부 평점", collection.externalScore == null ? null : `${collection.externalScore}`],
  ] as [string, string | null | undefined][]).filter((row): row is [string, string] => Boolean(row[1]));
}
