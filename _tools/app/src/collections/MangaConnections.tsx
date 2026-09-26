import { CheckIcon, ChevronDownIcon, ChevronRightIcon, LinkIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import type { BookConnection, MangaDexConnection } from "../library/types";
import { Button } from "../shared/ui/Button";
import "./mangaConnections.css";

type Props = {
  /** undefined while loading, null when not connected. */
  mangaDex: MangaDexConnection | null | undefined;
  kakao: BookConnection | null | undefined;
  mangaDexBusy: boolean;
  kakaoBusy: boolean;
  onConnectMangaDex: () => void;
  onRefreshMangaDex: () => void;
  onConnectKakao: () => void;
  onRefreshKakao: () => void;
};

const GAINS = { mangadex: "일본판 권 목록 · 표지 · 원제", kakao: "국내 출판 권 목록 · 발매일 · 신간 알림" } as const;

/**
 * MangaDex / 카카오 for a manga, as on the tablet. When both are connected it is one small folded
 * row, "연결 ✓MangaDex · ✓카카오", that opens to per-provider rows (새로고침, 다시 연결). Otherwise
 * it is a 작품 연결 panel with a choice per provider, Kakao (which brings 신간 알림) primary.
 */
export function MangaConnections({ mangaDex, kakao, mangaDexBusy, kakaoBusy, onConnectMangaDex, onRefreshMangaDex, onConnectKakao, onRefreshKakao }: Props) {
  const [open, setOpen] = useState(false);
  if (mangaDex === undefined || kakao === undefined) return null;
  const aladin = kakao?.provider === "aladin";
  const kakaoConnected = Boolean(kakao) && !aladin;
  const synced = (value: string | null | undefined) => value ? `마지막 갱신 ${new Date(value).toLocaleDateString("ko-KR")}` : "아직 갱신 전";

  if (mangaDex && kakaoConnected) return <section className="manga-connections is-folded" aria-label="연결">
    <button type="button" className="manga-connections__fold" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <LinkIcon aria-hidden="true" /><span>연결</span>
      <span className="manga-connections__ok"><CheckIcon aria-label="연결됨" />MangaDex</span>
      <span className="manga-connections__sep" aria-hidden="true" />
      <span className="manga-connections__ok"><CheckIcon aria-label="연결됨" />카카오</span>
      <ChevronDownIcon className="manga-connections__chevron" aria-hidden="true" />
    </button>
    {open && <div className="manga-connections__rows">
      <div className="manga-connections__row">
        <span className="manga-connections__name">MangaDex</span>
        <span className="manga-connections__state">연결됨<small>{synced(mangaDex.lastSyncedAt)}</small></span>
        <Button size="sm" variant="ghost" aria-label="MangaDex 새로고침" disabled={mangaDexBusy} onClick={onRefreshMangaDex}>{mangaDexBusy ? "새로고침 중…" : "새로고침"}</Button>
      </div>
      <div className="manga-connections__row">
        <span className="manga-connections__name">카카오</span>
        <span className="manga-connections__state">연결됨<small>{[kakao!.query, synced(kakao!.lastSyncedAt)].filter(Boolean).join(" · ")}</small></span>
        <Button size="sm" variant="ghost" aria-label="카카오 새로고침" disabled={kakaoBusy} onClick={onRefreshKakao}>{kakaoBusy ? "새로고침 중…" : "새로고침"}</Button>
        <Button size="sm" variant="ghost" aria-label="카카오 다시 연결" disabled={kakaoBusy} onClick={onConnectKakao}>다시 연결</Button>
      </div>
    </div>}
  </section>;

  const choice = (provider: "mangadex" | "kakao") => {
    const name = provider === "mangadex" ? "MangaDex" : "카카오";
    const connected = provider === "mangadex" ? Boolean(mangaDex) : kakaoConnected;
    const busy = provider === "mangadex" ? mangaDexBusy : kakaoBusy;
    if (connected) return <div key={provider} className="manga-connections__choice is-done">
      <CheckIcon aria-hidden="true" />
      <span className="manga-connections__text"><strong>{name} 연결됨</strong><small>{GAINS[provider]}</small></span>
      <Button size="sm" variant="ghost" aria-label={`${name} 새로고침`} disabled={busy} onClick={provider === "mangadex" ? onRefreshMangaDex : onRefreshKakao}>{busy ? "새로고침 중…" : "새로고침"}</Button>
    </div>;
    const primary = provider === "kakao";
    const label = provider === "kakao" && aladin ? "카카오로 재연결" : `${name} 연결`;
    return <button key={provider} type="button" className={`manga-connections__choice${primary ? " is-primary" : ""}`} aria-label={label}
      onClick={provider === "mangadex" ? onConnectMangaDex : onConnectKakao}>
      <span className="manga-connections__text"><strong>{label}</strong><small>{provider === "kakao" && aladin ? "알라딘 연결 · 기존 신간 확인이 중단됐습니다. 카카오로 다시 연결해 주세요." : GAINS[provider]}</small></span>
      <ChevronRightIcon aria-hidden="true" />
    </button>;
  };
  return <section className="manga-connections is-panel" aria-label="연결">
    <h2><LinkIcon aria-hidden="true" />작품 연결</h2>
    <p>연결하면 권별 표지와 발매일을 가져오고, 새 권이 나오면 신간 알림을 받을 수 있습니다.</p>
    <div className="manga-connections__choices">{choice("mangadex")}{choice("kakao")}</div>
  </section>;
}
