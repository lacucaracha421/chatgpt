import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { RevisitSlate } from "../library/types";
import { EmptyState } from "../shared/ui/EmptyState";
import { Skeleton } from "../shared/ui/Skeleton";
import { RevisitBundleCard } from "./RevisitBundleCard";

function localDateString(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function TodayView({ onOpenBundle }: { onOpenBundle?: (bundleId: string) => void }) {
  const { gateway } = useLibrary();
  const [slate, setSlate] = useState<RevisitSlate | null>(null);
  const [hiddenBundleIds, setHiddenBundleIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestSequence = useRef(0);

  const loadSlate = () => {
    const sequence = ++requestSequence.current;
    setPending(true);
    gateway
      .getRevisitSlate(localDateString(new Date()), new Date().toISOString())
      .then((result) => {
        if (requestSequence.current === sequence) setSlate(result);
      })
      .catch((cause: unknown) => {
        if (requestSequence.current === sequence) setError(commandErrorMessage(cause, "오늘의 다시보기를 불러오지 못했습니다."));
      })
      .finally(() => {
        if (requestSequence.current === sequence) setPending(false);
      });
  };

  useEffect(loadSlate, []);

  const reshuffleBundle = (bundleId: string) => {
    const sequence = ++requestSequence.current;
    setPending(true);
    gateway
      .reshuffleRevisitBundle(slate!.localDate, bundleId)
      .then((result) => {
        if (requestSequence.current === sequence) setSlate(result);
      })
      .catch((cause: unknown) => {
        if (requestSequence.current === sequence) setError(commandErrorMessage(cause, "묶음을 다시 섞지 못했습니다."));
      })
      .finally(() => {
        if (requestSequence.current === sequence) setPending(false);
      });
  };

  const reshuffleAll = () => {
    const sequence = ++requestSequence.current;
    setPending(true);
    gateway
      .reshuffleRevisitSlate(slate!.localDate)
      .then((result) => {
        if (requestSequence.current === sequence) setSlate(result);
      })
      .catch((cause: unknown) => {
        if (requestSequence.current === sequence) setError(commandErrorMessage(cause, "오늘의 추천을 다시 섞지 못했습니다."));
      })
      .finally(() => {
        if (requestSequence.current === sequence) setPending(false);
      });
  };

  if (error && slate === null) return <EmptyState title={error} />;
  if (slate === null) return <Skeleton className="revisit-today__skeleton" label="오늘의 다시보기를 불러오는 중" />;
  const bundles = (slate.bundles ?? []).filter((bundle) => !hiddenBundleIds.includes(bundle.id));
  const [hero, ...rest] = bundles;

  return <div className="revisit-today" aria-label="오늘">
    <header className="revisit-today__header">
      <h3>오늘</h3>
      <button type="button" className="revisit-today__reshuffle-all" title="전체 다시 섞기" aria-label="전체 다시 섞기" disabled={pending} onClick={reshuffleAll}><ArrowPathIcon aria-hidden="true" /></button>
    </header>
    {error && <div role="alert" className="revisit-today__error">{error}</div>}
    {hero && (
      <RevisitBundleCard
        bundle={hero}
        hero
        pending={pending}
        onOpen={onOpenBundle ? () => onOpenBundle(hero.id) : undefined}
        onReshuffle={() => reshuffleBundle(hero.id)}
        onDismiss={() => setHiddenBundleIds((current) => [...current, hero.id])}
      />
    )}
    <div className="revisit-today__grid">
      {rest.map((bundle) => <RevisitBundleCard
        key={bundle.id}
        bundle={bundle}
        pending={pending}
        onOpen={onOpenBundle ? () => onOpenBundle(bundle.id) : undefined}
        onReshuffle={() => reshuffleBundle(bundle.id)}
        onDismiss={() => setHiddenBundleIds((current) => [...current, bundle.id])}
      />)}
      {rest.length === 0 && <p className="revisit-today__empty-note">오늘은 더 준비된 묶음이 없습니다.</p>}
    </div>
  </div>;
}


