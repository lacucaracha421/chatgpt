import { useEffect, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import { Button } from "../shared/ui/Button";
import { ViewToolbar } from "../layout/ViewToolbar";
import type { ActivityStatistic, DerivativeStorage, LibraryStatistics, StatisticCount } from "./types";
import "./statistics.css";

const number = (value: number) => value.toLocaleString();
const bytes = (value: number) => `${(value / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 3 })} GiB`;
const date = (value: string) => new Date(value).toLocaleString();
const kindLabel: Record<string, string> = { image: "이미지", gif: "GIF", video: "영상" };

function CountTable({ title, definition, rows }: { title: string; definition: string; rows: StatisticCount[] }) {
  return <section className="statistics-section"><h2>{title}</h2><p>{definition}</p>
    {rows.length ? <dl>{rows.map((row, index) => <div key={`${row.label}-${index}`}><dt>{row.label}</dt><dd>{number(row.count)}</dd></div>)}</dl> : <p>집계할 자료가 없습니다.</p>}
  </section>;
}
function ActivityTable({ title, definition, rows }: { title: string; definition: string; rows: ActivityStatistic[] }) {
  return <section className="statistics-section"><h2>{title}</h2><p>{definition}</p>
    {rows.length ? <table><thead><tr><th scope="col">이름</th><th scope="col">열기</th><th scope="col">마지막 열기</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}><th scope="row">{row.label}</th><td>{number(row.count)}</td><td>{date(row.lastOpenedAt)}</td></tr>)}</tbody></table> : <p>조건에 맞는 열기 기록이 없습니다.</p>}
  </section>;
}

export function StatisticsPanel() {
  const { gateway, library } = useLibrary();
  const [revision, setRevision] = useState(0);
  const [data, setData] = useState<LibraryStatistics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [storage, setStorage] = useState<DerivativeStorage | null>(null);
  const [storageRequested, setStorageRequested] = useState(0);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  useEffect(() => { setStorageRequested(0); setStorage(null); setStorageError(null); }, [library?.root, revision]);
  useEffect(() => {
    if (!storageRequested || !library || !gateway.measureLibraryDerivativeStorage) return;
    let cancelled = false;
    setStorageLoading(true); setStorageError(null);
    void gateway.measureLibraryDerivativeStorage().then(value => { if (!cancelled) setStorage(value); })
      .catch(cause => { if (!cancelled) setStorageError(commandErrorMessage(cause, "저장 크기를 확인하지 못했습니다.")); })
      .finally(() => { if (!cancelled) setStorageLoading(false); });
    return () => { cancelled = true; setStorageLoading(false); };
  }, [gateway, library?.root, storageRequested]);
  useEffect(() => {
    let cancelled = false;
    setData(null); setError(null);
    if (!library) { setLoading(false); return; }
    if (!gateway.getLibraryStatistics) { setError("이 연결에서는 통계를 지원하지 않습니다."); setLoading(false); return; }
    setLoading(true);
    void gateway.getLibraryStatistics().then(value => { if (!cancelled) setData(value); })
      .catch(cause => { if (!cancelled) setError(commandErrorMessage(cause, "통계를 불러오지 못했습니다.")); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [gateway, library?.root, revision]);
  return <main className="statistics-panel" aria-label="개인 통계">
    <ViewToolbar title="통계" actions={<Button disabled={!library || loading} onClick={() => setRevision(value => value + 1)}>새로고침</Button>} />
    <p>현재 보관 상태와 실제로 기록된 열기 활동입니다.</p>
    {!library && <p>라이브러리를 열면 통계를 볼 수 있습니다.</p>}
    {loading && <p role="status">통계를 확인하고 있습니다.</p>}
    {error && <p role="alert">{error}</p>}
    {data && <>
      <section className="statistics-section"><h2>보관 현황</h2><p>정상 상태의 자산만 집계합니다. 휴지통·검토 대상은 제외합니다. 컬렉션은 전체 개수입니다.</p>
        <dl className="statistics-totals">{[["자산", data.assets], ["컬렉션", data.collections], ["즐겨찾는 자산", data.favorites], ["미분류 자산", data.unclassified]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{number(Number(value))}</dd></div>)}</dl>
      </section>
      <div className="statistics-grid">
        <CountTable title="미디어 종류" definition="원본 자산의 미디어 종류별 개수입니다." rows={data.mediaKinds.map(row => ({ ...row, label: kindLabel[row.label] ?? row.label }))} />
        <CountTable title="월별 수집" definition="현재 PC의 현지 시각 기준 수집 월입니다. 기록이 있는 최근 24개 월을 표시합니다." rows={data.collectedMonths} />
        <CountTable title="작가 상위 10명" definition="저장된 작가 핸들 또는 URL별 자산 수입니다. 작가 식별 정보가 없는 자산은 제외합니다." rows={data.creators} />
        <CountTable title="직접 분류 상위 10개" definition="직접 지정된 분류만 집계하며 상위 분류로 합산하지 않습니다. 같은 이름의 분류는 별개입니다." rows={data.classifications} />
      </div>
      <section className="statistics-section"><h2>저장 크기</h2><dl><div><dt>원본 · 수집 당시 기록 크기 합계</dt><dd>{bytes(data.originalRecordedBytes)}</dd></div>{storage && <div><dt>자산 파생 미디어 · 현재 읽을 수 있는 파일 합계</dt><dd>{bytes(storage.measuredBytes)}</dd></div>}</dl>
        <Button disabled={storageLoading || !gateway.measureLibraryDerivativeStorage} onClick={() => setStorageRequested(value => value + 1)}>{storageError ? "파생 미디어 크기 다시 확인" : "파생 미디어 크기 확인"}</Button>
        {storageLoading && <p role="status">등록된 파생 미디어를 최대 10,000개까지 확인하고 있습니다.</p>}
        {storageError && <p role="alert">{storageError}</p>}
        {storage && <p>{number(storage.measuredFiles)}개 확인 · 읽을 수 없는 파일 {number(storage.unavailableFiles)}개 제외.{storage.scanLimitReached && " 10,000개 확인 한도에 도달하여 전체 크기가 아닌 일부 합계입니다."}</p>}
        <p>현재 정상 자산에 등록된 썸네일·영상 포스터·호환 재생본·탐색 프레임을 확인합니다. 컬렉션 표지, 만화 페이지, 데이터베이스, 미등록 파일 및 디스크 할당 크기는 포함하지 않습니다. 확인 중 파일이 바뀔 수 있습니다.</p>
      </section>
      <section className="statistics-section"><h2>활동 기록 범위</h2><p>컬렉션 열기·일별 집계 시작: {date(data.collectionAndDailyStartedAt)}</p><p>기존 자산 누적 열기의 기록 시작일은 저장되어 있지 않아 알 수 없습니다. 노출 횟수나 파일 날짜로 과거 열기를 추정하지 않습니다. 상세 감상 세션에서 각 자산·컬렉션을 처음 열 때 한 번 집계합니다.</p></section>
      <ActivityTable title="많이 연 자산 · 상위 10개" definition="현재 정상 상태인 자산의 저장된 누적 열기 횟수입니다." rows={data.mostOpenedAssets} />
      <ActivityTable title="많이 연 컬렉션 · 상위 10개" definition="위 기록 시작 이후의 컬렉션 열기 횟수입니다." rows={data.mostOpenedCollections} />
      <ActivityTable title="30일 이상 다시 열지 않은 자산" definition="실제 마지막 열기가 30일 이상 지난 자산 중 오래된 순으로 최대 10개입니다. 열기 기록이 없는 자산은 포함하지 않습니다." rows={data.longUnseenAssets} />
      <section className="statistics-section"><h2>최근 30일 열기</h2><p>기록 시점의 PC 현지 날짜 기준입니다. 활동이 기록된 날만 표시하며 삭제된 자산·컬렉션의 당시 열기도 포함합니다. 하루 합계만 최대 90일 보관합니다.</p>
        {data.daily.length ? <table><thead><tr><th scope="col">날짜</th><th scope="col">자산</th><th scope="col">컬렉션</th></tr></thead><tbody>{data.daily.map(row => <tr key={row.localDate}><th scope="row">{row.localDate}</th><td>{number(row.assetOpens)}</td><td>{number(row.collectionOpens)}</td></tr>)}</tbody></table> : <p>아직 일별 열기 기록이 없습니다.</p>}
      </section>
    </>}
  </main>;
}
