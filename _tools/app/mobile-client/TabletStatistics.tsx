import {useEffect, useState} from 'react';
import {useDelayedBusy} from '../src/shared/useDelayedBusy';
import {displayDateTime} from '../src/shared/displayDate';
import {formatBytes} from '../src/shared/formatBytes';
import {BottomSheet} from './BottomSheet';
import {TabletHelp} from './TabletHelp';
import {Button, SectionLabel, Skeleton} from './ui';
import {api, errorText} from './transport';
import './tabletStatistics.css';

/** `GET /v1/library/statistics` (server `library_statistics.py`). */
type Count = {label: string; count: number};
export type ServerStatistics = {
  assets: number; mediaKinds: Count[]; favorites: number | null; unclassified: number; originalRecordedBytes: number;
  collections: {total: number; byType: Record<string, number>}; collectedMonths: Count[];
  artists: (Count & {id: string})[]; artistsPublishedAt: string | null; classifications: (Count & {id: string})[];
};

const KIND_LABELS: Record<string, string> = {image: '이미지', gif: 'GIF', video: '영상'};
const TYPE_LABELS: Record<string, string> = {game: '게임', manga: '만화', movie: '영화', av: 'AV'};
const number = (value: number) => value.toLocaleString('ko-KR');

function Counts({title, rows, help}: {title: string; rows: Count[]; help?: string}) {
  return <section className="tablet-statistics__section" aria-label={title}>
    <SectionLabel as="h3" title={title} actions={help ? <TabletHelp title={title}><p>{help}</p></TabletHelp> : undefined}/>
    {rows.length ? <dl className="tablet-statistics__rows">{rows.map((row, index) => <div key={`${row.label}-${index}`}><dt>{row.label}</dt><dd className="numeric">{number(row.count)}</dd></div>)}</dl>
      : <p className="tablet-statistics__empty">집계할 자료가 없습니다</p>}
  </section>;
}

/**
 * 통계 from More: what the server can count (PC `StatisticsPanel.tsx` 보관 현황, 미디어 종류, 월별 수집, 작가 및
 * 분류 상위). Opening activity and local file sizes exist only in the PC's own library and stay there.
 */
export function TabletStatistics({onClose}: {onClose(): void}) {
  const [data, setData] = useState<ServerStatistics | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<ServerStatistics>(`/v1/library/statistics?utcOffsetMinutes=${-new Date().getTimezoneOffset()}`, controller.signal).then(
      value => { if (!controller.signal.aborted) setData(value); },
      reason => { if (!controller.signal.aborted) setError(errorText(reason) || '통계를 불러오지 못했습니다.'); });
    return () => controller.abort();
  }, [retry]);
  const loading = useDelayedBusy(!data && !error);
  const totals: [string, number | null][] = data ? [['자산', data.assets], ['컬렉션', data.collections.total], ['좋아요', data.favorites], ['미분류 자산', data.unclassified]] : [];
  return <BottomSheet title="통계" tall onClose={onClose}><div className="tablet-statistics">
    {error && <div className="inline-error" role="alert">{error}<Button variant="quiet" onClick={() => setRetry(value => value + 1)}>다시 시도</Button></div>}
    {!data && !error && loading && <Skeleton className="tablet-statistics__skeleton" label="통계"/>}
    {data && <>
      <section className="tablet-statistics__section" aria-label="보관 현황">
        <SectionLabel as="h3" title="보관 현황" actions={<TabletHelp title="보관 현황"><p>휴지통에 있는 자산과 컬렉션 표지는 빼고 셉니다. 좋아요는 좋아요 앨범의 자산 수입니다.</p></TabletHelp>}/>
        <dl className="tablet-statistics__totals">{totals.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className="numeric">{value === null ? '—' : number(value)}</dd></div>)}</dl>
      </section>
      <div className="tablet-statistics__grid">
        <Counts title="미디어 종류" rows={data.mediaKinds.map(row => ({...row, label: KIND_LABELS[row.label] ?? row.label}))}/>
        <Counts title="컬렉션 종류" rows={Object.entries(data.collections.byType).filter(([, count]) => count > 0).map(([type, count]) => ({label: TYPE_LABELS[type] ?? type, count}))}/>
        <Counts title="월별 수집" rows={data.collectedMonths} help="이 태블릿의 현지 시각 기준 저장 월입니다. 기록이 있는 최근 24개 월을 표시합니다."/>
        <Counts title="작가 상위 10명" rows={data.artists} help={`PC가 보낸 작가 목록의 장수입니다. 합친 작가는 함께 셉니다.${data.artistsPublishedAt ? ` 마지막으로 받은 때: ${displayDateTime(data.artistsPublishedAt, new Date(), {withDate: true})}` : ''}`}/>
        <Counts title="직접 분류 상위 10개" rows={data.classifications} help="직접 지정한 분류만 셉니다. 상위 분류로 합산하지 않습니다."/>
      </div>
      <section className="tablet-statistics__section" aria-label="저장 크기">
        <SectionLabel as="h3" title="저장 크기"/>
        <dl className="tablet-statistics__rows"><div><dt>원본 · 수집 당시 기록 크기 합계</dt><dd className="numeric">{formatBytes(data.originalRecordedBytes)}</dd></div></dl>
      </section>
      <section className="tablet-statistics__section" aria-label="PC 앱에서">
        <SectionLabel as="h3" title="PC 앱에서"/>
        <p className="tablet-statistics__empty">열기 기록(많이 연 자산·컬렉션, 오래 열지 않은 자산, 최근 30일 열기)과 파생 미디어 크기</p>
      </section>
    </>}
  </div></BottomSheet>;
}
