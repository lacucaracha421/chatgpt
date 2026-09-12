import { ArrowPathIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import { ViewToolbar } from "../layout/ViewToolbar";
import type { RevisitSlate } from "../library/types";
import { Button } from "../shared/ui/Button";
import { RevisitBundleCard } from "./RevisitBundleCard";

const themes = [
  { kind: "creator", title: "작가 다시보기", reason: "한 작가의 자료를 다시 만나는 시간", empty: "이번 추천에는 준비된 작가 묶음이 없습니다." },
  { kind: "date", title: "과거 수집함", reason: "이맘때 수집한 오래된 자료", empty: "이번 추천에는 준비된 과거 묶음이 없습니다." },
  { kind: "color", title: "비슷한 색감", reason: "한 이미지에서 이어지는 색의 흐름", empty: "이번 추천에는 준비된 색감 묶음이 없습니다." },
] as const;

type ColorState = "idle" | "preparing" | "empty" | "failed";

function localDateString(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function TodayView({ onOpenBundle, navigation }: { onOpenBundle?: (bundleId: string) => void; navigation?: ReactNode }) {
  const { gateway, library } = useLibrary();
  const [slate, setSlate] = useState<RevisitSlate | null>(null);
  const [hiddenBundleIds, setHiddenBundleIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestSequence = useRef(0);
  const [colorState, setColorState] = useState<ColorState>("idle");

  // Color preparation is optional: the base slate owns the loading state.
  const prepareColor = (base: RevisitSlate, sequence: number) => {
    if (base.bundles.some((bundle) => bundle.kind === "color")) { setColorState("idle"); return; }
    setColorState("preparing");
    const requestDate = localDateString(new Date());
    void gateway.prepareRevisitColorBundle(base.localDate, new Date().toISOString(), base.revision)
      .then((result) => {
        if (requestSequence.current !== sequence || localDateString(new Date()) !== requestDate) return;
        if (result) setSlate(result);
        setColorState(result?.bundles.some((bundle) => bundle.kind === "color") ? "idle" : "empty");
      })
      .catch(() => {
        if (requestSequence.current === sequence) setColorState("failed");
      });
  };

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const requestDate = localDateString(new Date());
    setSlate(null);
    setError(null);
    setNotice(null);
    setColorState("idle");
    setHiddenBundleIds([]);
    setPending(true);
    gateway.getRevisitSlate(requestDate, new Date().toISOString())
      .then((result) => {
        if (requestSequence.current !== sequence || localDateString(new Date()) !== requestDate) return;
        setSlate(result);
        prepareColor(result, sequence);
      })
      .catch((cause: unknown) => {
        if (requestSequence.current === sequence) setError(commandErrorMessage(cause, "오늘의 다시보기를 불러오지 못했습니다."));
      })
      .finally(() => {
        if (requestSequence.current === sequence) setPending(false);
      });
    return () => { ++requestSequence.current; };
  }, [gateway, library]);

  const reshuffleBundle = (bundleId: string) => {
    const sequence = ++requestSequence.current;
    setPending(true);
    setError(null);
    setNotice(null);
    setColorState("idle");
    gateway
      .reshuffleRevisitBundle(slate!.localDate, bundleId)
      .then((result) => {
        if (requestSequence.current === sequence) {
          setSlate(result);
          if (result.bundles.some((bundle) => bundle.id === bundleId && bundle.kind === "color")) {
            setNotice("이번에는 새로운 색감 묶음을 찾지 못했습니다. 기존 묶음을 유지합니다.");
          }
        }
      })
      .catch((cause: unknown) => {
        if (requestSequence.current === sequence) setError(commandErrorMessage(cause, "묶음을 다시 섞지 못했습니다."));
      })
      .finally(() => {
        if (requestSequence.current === sequence) setPending(false);
      });
  };

  const reshuffleAll = () => {
    if (!slate) return;
    const sequence = ++requestSequence.current;
    setPending(true);
    setError(null);
    setNotice(null);
    setColorState("idle");
    gateway
      .reshuffleRevisitSlate(slate!.localDate)
      .then((result) => {
        if (requestSequence.current === sequence) {
          setSlate(result);
          setHiddenBundleIds([]);
          prepareColor(result, sequence);
        }
      })
      .catch((cause: unknown) => {
        if (requestSequence.current === sequence) setError(commandErrorMessage(cause, "오늘의 추천을 다시 섞지 못했습니다."));
      })
      .finally(() => {
        if (requestSequence.current === sequence) setPending(false);
      });
  };

  return <>
    <ViewToolbar
      title="다시보기"
      ariaLabel="다시보기 도구"
      chrome={{
        navigation,
        actions: <Button size="icon" variant="ghost" aria-description="전체 다시 섞기" aria-label="전체 다시 섞기" disabled={pending || slate === null} onClick={reshuffleAll}><ArrowPathIcon aria-hidden="true" /></Button>,
      }}
    />
    <div className="revisit-today" aria-label="오늘">
      {error && <div role="alert" className="revisit-today__error">{error}</div>}
      {notice && <p role="status">{notice}</p>}
      <div className="revisit-today__grid" aria-label="다시보기 테마">
        {themes.map((theme, index) => {
          const bundle = slate?.bundles.find((bundle) => bundle.kind === theme.kind);
          const hidden = bundle && hiddenBundleIds.includes(bundle.id);
          const ordinal = String(index + 1).padStart(2, "0");
          if (bundle && !hidden) return <RevisitBundleCard
            key={theme.kind} bundle={{ ...bundle, title: theme.title }} ordinal={ordinal} pending={pending}
            onOpen={onOpenBundle ? () => onOpenBundle(bundle.id) : undefined}
            onReshuffle={() => reshuffleBundle(bundle.id)}
            onDismiss={() => setHiddenBundleIds((current) => [...current, bundle.id])}
          />;
          const preparing = !hidden && (slate === null && !error || theme.kind === "color" && colorState === "preparing");
          const failed = theme.kind === "color" && colorState === "failed";
          const message = hidden ? "이 묶음을 숨겼습니다." : preparing
            ? theme.kind === "color" ? "비슷한 색감의 자료를 찾고 있습니다." : "오늘의 자료를 준비하고 있습니다."
            : failed ? "색감 추천을 준비하지 못했습니다." : error && slate === null ? "추천을 불러오지 못했습니다." : theme.empty;
          return <section key={theme.kind} className="revisit-bundle revisit-bundle--empty" aria-label={theme.title} aria-busy={preparing}>
            <header className="revisit-bundle__header">
              <span className="revisit-bundle__ordinal" aria-hidden="true">{ordinal}</span>
              <h4>{theme.title}<span className="revisit-bundle__reason">{theme.reason}</span></h4>
            </header>
            <div className="revisit-bundle__empty" role="status">
              <span className="revisit-bundle__empty-mark" aria-hidden="true">◇</span>
              <p>{message}</p>
              {failed && <p className="revisit-bundle__empty-detail">전체 다시 섞기로 다시 시도할 수 있습니다.</p>}
            </div>
            <span className="revisit-bundle__count">{preparing ? "준비 중" : hidden ? "숨김" : "추천 대기"}</span>
          </section>;
        })}
      </div>
    </div>
  </>;
}
