import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import type { CatalogGroupedWork, CatalogGroupEditionsPage, CatalogLanguage, CatalogWork } from "../library/types";
import { commandErrorMessage } from "../library/errorMessage";
import { Dialog } from "../shared/ui/Dialog";
import { Button } from "../shared/ui/Button";
import { catalogIdentityKey } from "./catalogIdentity";
import "./CatalogEditionsDialog.css";

type Props = {
  work: CatalogGroupedWork;
  language: CatalogLanguage;
  revealBlocked: boolean;
  onOpen: (work: CatalogWork) => void;
  onClose: () => void;
  onRepresentativeChange: () => void;
};

export function CatalogEditionsDialog({ work, language, revealBlocked, onOpen, onClose, onRepresentativeChange }: Props) {
  const { gateway } = useLibrary();
  const [data, setData] = useState<CatalogGroupEditionsPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const active = useRef(true);

  async function load(page: number) {
    const current = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const next = await gateway.getCatalogGroupEditions({ provider: work.provider, groupId: work.groupId, language, revealBlocked, page, pageSize: 40 });
      if (current !== request.current || !active.current) return;
      setData((previous) => ({ ...next, works: page === 0 ? next.works : [...(previous?.works ?? []), ...next.works] }));
    } catch (error) {
      if (current === request.current && active.current) setError(commandErrorMessage(error, "판본을 불러오지 못했습니다"));
    } finally {
      if (current === request.current && active.current) setLoading(false);
    }
  }

  useEffect(() => {
    active.current = true;
    setData(null);
    void load(0);
    return () => { active.current = false; request.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, work.provider, work.groupId, language, revealBlocked]);

  async function select(selectedProviderWorkId: string | null) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await gateway.setCatalogGroupRepresentative({ provider: work.provider, groupId: work.groupId, selectedProviderWorkId });
      if (active.current) setData((current) => current && ({ ...current, selectedProviderWorkId }));
      onRepresentativeChange();
    } catch (error) {
      if (active.current) setError(commandErrorMessage(error, "대표 판본을 변경하지 못했습니다"));
    } finally {
      if (active.current) setSaving(false);
    }
  }

  return <Dialog open title="작품 판본" variant="medium" onClose={onClose}>
    <div className="catalog-editions">
      <div className="catalog-editions__toolbar">
        <span>{data ? `${data.totalCount}개 판본` : "판본을 불러오는 중…"}</span>
        <Button size="sm" disabled={saving || loading} aria-pressed={data?.selectedProviderWorkId === null} onClick={() => void select(null)}>자동 선택</Button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="catalog-editions__list" aria-busy={loading}>
        {data?.works.map((edition) => <div className="catalog-editions__row" key={catalogIdentityKey(edition)}>
          <Button variant="ghost" aria-label={`${edition.title} 열기`} onClick={() => onOpen(edition)}>{edition.title}</Button>
          <span>{edition.fileCount}페이지{edition.bookmarked ? " · 북마크" : ""}</span>
          <Button size="sm" disabled={saving || loading} aria-label={`${edition.title} 대표로 지정`} aria-pressed={data.selectedProviderWorkId === edition.providerWorkId} onClick={() => void select(edition.providerWorkId)}>대표로 지정</Button>
        </div>)}
      </div>
      <div className="catalog-editions__toolbar">
        {data && (data.page + 1) * data.pageSize < data.totalCount && <Button size="sm" disabled={loading || saving} onClick={() => void load(data.page + 1)}>판본 더 보기</Button>}
        {error && <Button size="sm" disabled={loading} onClick={() => void load(data ? data.page + 1 : 0)}>다시 시도</Button>}
        <Button size="sm" onClick={onClose}>닫기</Button>
      </div>
    </div>
  </Dialog>;
}
