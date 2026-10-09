import type { CaseData, Fact } from "./CollectionCase";
import "./CaseBack.css";

export type CaseBackContent = {
  hero?: string | null;
  overview?: string | null;
  screenshots?: string[];
  facts?: Fact[];
  publisher?: string | null;
  platformName?: string | null;
};

const platformNames = { sw2: "Nintendo Switch 2", sw: "Nintendo Switch", ps5: "PlayStation 5", pc: "PC", other: "", film: "FILM", av: "AV", book: "" };

/** Printed only when a work has no back artwork; all content comes from the work. */
export function CaseBack({ data, content = {} }: { data: CaseData; content?: CaseBackContent }) {
  const hero = content.hero || data.front;
  const screenshots = content.screenshots?.filter(Boolean).slice(0, 3) ?? [];
  return <div className={`case-back case-back--${data.platform}`} aria-label="생성 뒤표지">
    <div className={`case-back-hero${!content.hero ? " is-fallback" : ""}`} style={hero ? { backgroundImage: `url(${JSON.stringify(hero)})` } : undefined}>
      <b>{data.title}</b>
    </div>
    <div className="case-back-body">
      {content.overview?.trim() && <p className="case-back-copy">{content.overview}</p>}
      {screenshots.length > 0 && <div className="case-back-shots" aria-label="스크린샷">{screenshots.map((src, index) =>
        <img key={`${src}/${index}`} src={src} alt={`${data.title} 스크린샷 ${index + 1}`} draggable={false} />)}</div>}
      {Boolean(content.facts?.length) && <dl className="case-back-facts">{content.facts!.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    </div>
    <div className="case-back-foot"><span className="case-back-pub">{content.publisher === undefined ? data.publisher : content.publisher}</span><span className="case-back-plat">{content.platformName || platformNames[data.platform]}</span></div>
  </div>;
}
