import type { ReactNode } from "react";
import { recordStates } from "../work/WorkRecord";
import type { Fact } from "./CollectionCase";
import "./CaseInside.css";

export type CasePerson = { id: string; name: string; role: "performer" | "director"; order: number; portrait?: ReactNode };

/** Printed stars retain fractional ratings without turning the booklet into an editor. */
export function CaseScore({ score }: { score: number | null }) {
  return <span className="case-score" role="img" aria-label={`내 별점 ${score ?? "미평가"}`}>
    {[1, 2, 3, 4, 5].map(value => <span key={value} aria-hidden="true">☆<span style={{ width: `${Math.max(0, Math.min(1, (score ?? 0) - value + 1)) * 100}%` }}>★</span></span>)}
  </span>;
}

function PrintedStatus({ type, current }: { type: string; current: ReactNode }) {
  return <span className="case-status">{(recordStates[type] ?? []).map(([value, label]) =>
    <span key={value} className={`case-status-box${current === label ? " is-filled" : ""}`} data-status={value} role="img" aria-label={`${label}: ${current === label ? "선택됨" : "선택 안 됨"}`}>{label}</span>)}</span>;
}

const blank = <span className="case-writing-line" aria-label="미입력" />;

export function CaseInside({ title, type, record, facts, hero, front, privacy = false, people = [] }: {
  title: string; type: string; record: Fact[]; facts: Fact[]; hero?: string | null; front?: string | null; privacy?: boolean; people?: CasePerson[];
}) {
  if (privacy) return <span className="case-mask" aria-label="비공개 모드" />;
  const fact = (label: string) => facts.find(row => row[0] === label)?.[1];
  const personal = (label: string) => record.find(row => row[0] === label)?.[1];
  const status = <PrintedStatus type={type} current={personal("상태")} />;
  const clips = <><span className="case-tab case-tab-one" aria-hidden="true" /><span className="case-tab case-tab-two" aria-hidden="true" /></>;
  if (type === "av") {
    const cast = people.filter(person => person.role === "performer").sort((a, b) => a.order - b.order);
    const shown = cast.slice(0, cast.length > 3 ? 2 : 3);
    const directors = people.filter(person => person.role === "director").sort((a, b) => a.order - b.order);
    return <>{clips}<div className="case-booklet case-av-book">
      <b className="case-av-code">{fact("품번") || title}</b><span className="case-booklet-subtitle">{fact("메이커")}</span>
      <dl className="case-av-rows">{["레이블", "발매", "수록"].map(label => <div key={label}><dt>{label}</dt><dd>{fact(label) || blank}</dd></div>)}</dl>
      <div className="case-av-record">{status}{personal("내 별점")}</div>
    </div>
      {directors.length > 0 && <div className="case-director">감독 · {directors.map(person => person.name).join(" · ")}</div>}
      {cast.length > 0 && <div className="case-cast" data-count={Math.min(cast.length, 3)} aria-label="출연">
        {shown.map(person => <div className="case-pola" key={person.id}>
          <div className="case-pola-photo" aria-hidden="true"
            onErrorCapture={event => { if (event.target instanceof HTMLImageElement) event.target.style.opacity = "0"; }}
            onLoadCapture={event => { if (event.target instanceof HTMLImageElement) event.target.style.removeProperty("opacity"); }}>
            <span className="case-silhouette" />
            {person.portrait}
          </div><span className="case-pola-name">{person.name}</span>
        </div>)}
        {cast.length > 3 && <div className="case-pola case-pola-more"><div className="case-pola-photo">+{cast.length - 2}</div><span className="case-pola-name">출연</span></div>}
      </div>}
    </>;
  }
  const cover = hero || front;
  const platform = personal("기기");
  return <>{clips}<div className="case-booklet case-manual">
    <span className="case-staple case-staple-one" aria-hidden="true" /><span className="case-staple case-staple-two" aria-hidden="true" />
    <div className="case-manual-cover" style={cover ? { backgroundImage: `url(${JSON.stringify(cover)})` } : undefined} />
    <b className="case-manual-title">{title}</b><span className="case-booklet-subtitle">취급 설명서</span>
    <dl className="case-manual-form">
      <div><dt>상태</dt><dd>{status}</dd></div><div><dt>내 별점</dt><dd>{personal("내 별점")}</dd></div>
      {type === "game" && <div><dt>기기</dt><dd>{platform && platform !== "미입력" ? platform : blank}</dd></div>}
    </dl>
    <div className="case-manual-footer">{type === "movie" ? <>
      <span>{fact("감독")}</span><span>{fact("개봉")}</span><span>{fact("러닝타임")}</span>
    </> : <><span>{[fact("개발사"), fact("배급사")].filter(Boolean).map((value, index) => <span key={index}>{index > 0 && " · "}{value}</span>)}</span><span>{fact("발매")}</span></>}</div>
  </div></>;
}
