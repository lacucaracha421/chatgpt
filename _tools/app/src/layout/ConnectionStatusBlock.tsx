import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import type { CloudSyncStatus } from "../app/useCloudProblems";
import { exchangeStore, useExchangeSnapshot } from "../exchange/exchangeStore";
import { agoLabel, clockLabel, cloudLine, serverOutage } from "../home/homeModel";
import type { AssetView, AuthoritySyncHealth, CatalogStatus, LibraryGateway, ReleaseCalendar } from "../library/types";

type Tone = "ok" | "busy" | "idle" | "off";
export type ConnectionRow = { key: string; label: string; value: string; time?: string; tone: Tone; view: AssetView };

/**
 * 연결 in the 상태 panel (moved from the Home index, 2026-09-28): server, tablet, cloud,
 * catalog and 발매 캘린더, one line each. Read when the panel opens.
 */
export function useConnectionRows({ gateway, cloud, authorityHealth }: {
  gateway: LibraryGateway; cloud?: CloudSyncStatus; authorityHealth: AuthoritySyncHealth | null;
}): ConnectionRow[] {
  const transfer = useExchangeSnapshot(exchangeStore);
  const [catalog, setCatalog] = useState<CatalogStatus | null>(null);
  const [calendar, setCalendar] = useState<ReleaseCalendar | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => gateway.getOnlineCatalogStatus()).then((value) => { if (live) setCatalog(value ?? null); }, () => undefined);
    void gateway.releaseCalendar?.calendar().then((value) => { if (live) setCalendar(value ?? null); }, () => undefined);
    return () => { live = false; };
  }, [gateway]);

  const at = new Date();
  const outage = serverOutage(authorityHealth, cloud?.progress ?? null);
  const rows: ConnectionRow[] = [];
  if (authorityHealth) {
    rows.push(outage
      ? { key: "server", label: "서버", value: "연결 안 됨", time: outage.since ? `${clockLabel(outage.since)}부터` : undefined, tone: "off", view: { kind: "settings", section: "connection" } }
      : { key: "server", label: "서버", value: "연결됨", tone: "ok", view: { kind: "settings", section: "connection" } });
  }
  if (transfer.availability.state !== "unavailable") {
    const tone: Tone = transfer.availability.state === "ready" ? "ok" : transfer.availability.state === "starting" ? "busy" : outage ? "idle" : "off";
    rows.push({ key: "tablet", label: "태블릿", value: transfer.devices[0]?.name ?? "연결된 기기 없음", time: transfer.availability.state === "offline" ? "연결 안 됨" : undefined, tone, view: { kind: "exchange" } });
  }
  const cloudState = cloudLine(cloud?.progress ?? null, cloud?.problemCount ?? 0);
  if (cloudState) rows.push({ key: "cloud", label: "클라우드", value: cloudState.text, tone: outage && cloudState.tone !== "ok" ? "idle" : cloudState.tone, view: { kind: "settings", section: "connection" } });
  if (catalog?.installed) {
    const time = catalog.lastSuccessAt ? agoLabel(catalog.lastSuccessAt, at) : undefined;
    rows.push({ key: "catalog", label: "카탈로그", value: catalog.lastError ? "갱신 실패" : "갱신 완료", time, tone: catalog.lastError ? "off" : "ok", view: { kind: "settings", section: "catalog" } });
  }
  if (calendar) {
    const fetched = calendar.sources.map((source) => source.fetchedAt).filter((value): value is string => Boolean(value)).sort().reverse()[0];
    const failed = calendar.sources.some((source) => source.errorCode);
    rows.push({ key: "calendar", label: "발매 캘린더", value: failed ? "가져올 수 없음" : "IGDB · TMDB",
      time: fetched ? (failed ? `${clockLabel(fetched)} 기준` : agoLabel(fetched, at)) : undefined, tone: failed ? "off" : "ok", view: { kind: "settings", section: "connection" } });
  }
  return rows;
}

export function ConnectionStatusBlock({ gateway, cloud, authorityHealth, onNavigate }: {
  gateway: LibraryGateway; cloud?: CloudSyncStatus; authorityHealth: AuthoritySyncHealth | null; onNavigate: (view: AssetView) => void;
}) {
  const rows = useConnectionRows({ gateway, cloud, authorityHealth });
  if (rows.length === 0) return null;
  return <section className="status-center__block" aria-label="연결">
    <h3 className="status-center__heading">연결</h3>
    {rows.map((row) => <button key={row.key} type="button" className="status-center__connection" data-tone={row.tone} onClick={() => onNavigate(row.view)} aria-label={`${row.label} ${row.value}`}>
      <span className="status-center__dot" aria-hidden="true" />
      <span className="status-center__connection-label">{row.label}</span>
      <span className="status-center__connection-value">{row.value}{row.time && <small> · {row.time}</small>}</span>
      <ChevronRightIcon aria-hidden="true" className="status-center__queue-arrow" />
    </button>)}
  </section>;
}
