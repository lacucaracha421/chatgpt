import type { Note } from "../notes/store";
import { newQuickMemo } from "./quickMemo";

export type KeptLink = { url: string; title: string; siteName?: string | null; imageUrl?: string | null; savedAt: string; imported?: number };
export type LinkPreview = Pick<KeptLink, "title" | "siteName" | "imageUrl">;
const KEY = "lakomics.home.links.v1:";
export function linkUrl(value: string): string | null {
  try { const url = new URL(value.trim()); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export const domain = (url: string) => new URL(url).hostname.replace(/^www\./, "");
export function readLinksId(root: string): string | null { try { return localStorage.getItem(KEY + root); } catch { return null; } }
export function writeLinksId(root: string, id: string) { try { localStorage.setItem(KEY + root, id); } catch { /* Title lookup works without storage. */ } }
export function findLinksNote(notes: Note[], savedId: string | null): Note | null {
  const usable = notes.filter(n => !n.deleted && (n.type ?? "text") === "text");
  return usable.find(n => n.id === savedId) ?? usable.filter(n => n.title.trim() === "링크 보관")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0] ?? null;
}
export function newLinksNote(links: KeptLink[]): Note { return { ...newQuickMemo(serializeLinks(links)), title: "링크 보관" }; }
export function serializeLinks(links: KeptLink[]): string { return "링크 보관\n\n```json\n" + JSON.stringify(links, null, 2) + "\n```"; }
/** Refuse malformed content rather than replacing a note edited in 메모. */
export function parseLinks(body: string): KeptLink[] {
  if (!body.trim()) return [];
  const fenced = /```json\s*\n([\s\S]*?)\n```/.exec(body);
  if (fenced) {
    const before = body.slice(0, fenced.index).trim();
    const after = body.slice(fenced.index + fenced[0].length).trim();
    if ((before && before !== "링크 보관") || after) throw new Error("링크 목록 밖에 작성한 내용을 먼저 확인해 주세요.");
  }
  let rows: unknown;
  if (fenced || body.trim().startsWith("[")) rows = JSON.parse(fenced?.[1] ?? body);
  else {
    const urls = body.trim().split(/\r?\n/).filter(Boolean);
    if (!urls.every(url => linkUrl(url))) throw new Error("링크 보관 메모의 형식을 확인해 주세요.");
    rows = urls.map(url => ({ url, title: domain(linkUrl(url)!), savedAt: new Date(0).toISOString() }));
  }
  if (!Array.isArray(rows)) throw new Error("링크 목록이 아닙니다.");
  const out: KeptLink[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || typeof row.url !== "string" || !linkUrl(row.url) || typeof row.title !== "string"
      || typeof row.savedAt !== "string" || !Number.isFinite(Date.parse(row.savedAt))
      || (row.imageUrl != null && (typeof row.imageUrl !== "string" || !linkUrl(row.imageUrl)))
      || (row.siteName != null && typeof row.siteName !== "string")
      || (row.imported != null && (!Number.isInteger(row.imported) || row.imported < 0))) throw new Error("링크 보관 메모의 형식을 확인해 주세요.");
    const url = linkUrl(row.url)!;
    if (!out.some(link => link.url === url)) out.push({ ...row, url });
  }
  return out;
}
export function keepLink(links: KeptLink[], url: string, now = new Date()): KeptLink[] {
  const normalized = linkUrl(url);
  if (!normalized) throw new Error("http 또는 https URL을 붙여넣어 주세요.");
  return [{ ...(links.find(link => link.url === normalized) ?? { url: normalized, title: domain(normalized) }), savedAt: now.toISOString() }, ...links.filter(link => link.url !== normalized)];
}
export function linkTime(stamp: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(stamp)) / 60000));
  return minutes < 1 ? "방금" : minutes < 60 ? `${minutes}분 전` : minutes < 1440 ? `${Math.floor(minutes / 60)}시간 전` : `${Math.floor(minutes / 1440)}일 전`;
}
