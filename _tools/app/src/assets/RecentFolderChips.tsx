import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { CheckIcon, ClockIcon, UserGroupIcon } from "@heroicons/react/24/outline";
import { ClassificationIcon, classificationColor } from "../classification/classificationAppearance";
import { Button } from "../shared/ui/Button";
import { Badge } from "../shared/ui/Badge";
import { ContextMenu } from "../shared/ui/ContextMenu";
import { Menu } from "../shared/ui/Menu";
import { SectionLabel } from "../shared/ui/SectionLabel";
import { hasDuplicateRecentName, useRecentFolders, type RecentChipFolder, type RecentFolder, type RecentFoldersState } from "./recentFolders";
import "./recentFolders.css";

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function FolderGlyph({ folder }: { folder: RecentChipFolder }) {
  return folder.group ? <UserGroupIcon aria-hidden="true" /> : <ClassificationIcon kind={folder.folder.kind} iconKey={folder.folder.iconKey} testId={false} />;
}

/** Shared quiet chip; the desktop bar owns fitting, while another surface can scroll it. */
export function RecentFolderChip({ folder, duplicate, current, onOpen, onRemove, leaving = false, style }: {
  folder: RecentChipFolder; duplicate: boolean; current: boolean; onOpen: () => void; onRemove: () => void;
  leaving?: boolean; style?: CSSProperties;
}) {
  return <ContextMenu items={[{ id: "remove", label: "최근에서 빼기", onSelect: onRemove }]}>
    <Button type="button" variant="quiet" className={`recent-folders__chip${leaving ? " is-leaving" : " is-entering"}`}
      data-recent-id={folder.id} aria-description={folder.path} aria-current={current ? "page" : undefined}
      style={{ "--folder-color": classificationColor(folder.folder.colorKey), ...style } as CSSProperties}
      inert={leaving || undefined} aria-hidden={leaving || undefined} onClick={onOpen}>
      <FolderGlyph folder={folder} /><span>{duplicate && folder.parentName && <span className="recent-folders__parent">{folder.parentName} › </span>}{folder.name}</span>
    </Button>
  </ContextMenu>;
}

export function RecentFolders({ state }: { state?: RecentFoldersState }) {
  const context = useRecentFolders();
  const history = state ?? context;
  return history ? <RecentFoldersBar history={history} /> : null;
}

function RecentFoldersBar({ history }: { history: RecentFoldersState }) {
  const { folders, currentId, open, remove, clear } = history;
  const list = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, DOMRect>());
  const previous = useRef(folders.slice(0, 5));
  const leaveTimer = useRef<number | undefined>(undefined);
  const [departing, setDeparting] = useState<Array<{ folder: RecentFolder; style: CSSProperties }>>([]);
  const [visibleCount, setVisibleCount] = useState(5);
  const first = folders.slice(0, 5);
  const ids = first.map(folder => folder.id).join("\0");

  useEffect(() => {
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const stopMotion = () => {
      if (!preference?.matches) return;
      list.current?.querySelectorAll<HTMLElement>("[data-recent-id]").forEach(chip => chip.getAnimations?.().forEach(animation => animation.cancel()));
      setDeparting([]);
    };
    preference?.addEventListener("change", stopMotion);
    return () => { window.clearTimeout(leaveTimer.current); preference?.removeEventListener("change", stopMotion); };
  }, []);

  useLayoutEffect(() => {
    const host = list.current;
    if (!host) return;
    const leaving = previous.current.filter(folder => !first.some(next => next.id === folder.id));
    previous.current = first;
    if (leaving.length && !reducedMotion()) {
      const oldPositions = positions.current;
      setDeparting(leaving.flatMap(folder => {
        const rect = oldPositions.get(folder.id);
        return rect ? [{ folder, style: { left: rect.left - host.getBoundingClientRect().left, width: rect.width } }] : [];
      }));
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = window.setTimeout(() => setDeparting([]), 120);
    }
    const measure = () => {
      const chips = [...host.querySelectorAll<HTMLElement>("[data-recent-id]:not(.is-leaving)")];
      // Measure the full first five in the same layout pass; no intermediate state paints.
      chips.forEach(chip => { chip.hidden = false; });
      const room = host.getBoundingClientRect().right;
      let count = chips.length;
      for (let index = chips.length - 1; index >= 0; index--) {
        if (chips[index].getBoundingClientRect().right <= room + 0.5) break;
        chips[index].hidden = true;
        count--;
      }
      setVisibleCount(count);
      const nextPositions = new Map<string, DOMRect>();
      for (const chip of chips) {
        if (chip.hidden) continue;
        const id = chip.dataset.recentId!;
        const rect = chip.getBoundingClientRect();
        nextPositions.set(id, rect);
        const was = positions.current.get(id);
        if (was && !reducedMotion() && was.left !== rect.left) {
          const easing = getComputedStyle(chip).getPropertyValue("--ease-standard").trim() || "ease-out";
          chip.animate?.([{ transform: `translateX(${was.left - rect.left}px)` }, { transform: "translateX(0)" }], { duration: 200, easing });
        }
      }
      positions.current = nextPositions;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [ids, folders]);

  const hiddenCount = folders.length - Math.min(visibleCount, first.length);
  if (!folders.length && reducedMotion()) { previous.current = []; return null; }
  if (!folders.length && !departing.length && !previous.current.length) return null;
  return <div className="recent-folders" role="group" aria-label="최근 폴더">
    {folders.length > 0 && <Menu label="최근 폴더" triggerClassName="ui-button ui-button--quiet recent-folders__more" contentClassName="recent-folders__menu"
      trigger={<><ClockIcon aria-hidden="true" />{hiddenCount > 0 && <Badge variant="corner" aria-label={`숨겨진 폴더 ${hiddenCount}개`}>{hiddenCount}</Badge>}</>}
      content={<>
        <DropdownMenu.Label asChild><SectionLabel title="최근 폴더" /></DropdownMenu.Label>
        {folders.map(folder => <DropdownMenu.Item key={folder.id} asChild onSelect={() => open(folder)}>
          <button type="button" className="ui-menu__item" data-selected={folder.id === currentId || undefined} aria-description={folder.path}
            style={{ "--folder-color": classificationColor(folder.folder.colorKey) } as CSSProperties}>
            <span className="ui-menu__item-icon"><FolderGlyph folder={folder} /></span>
            <span className="ui-menu__item-label">{folder.name}</span>
            <span className="recent-folders__path"><bdi>{folder.path}</bdi></span>
            {folder.id === currentId && <CheckIcon className="ui-menu__item-check" aria-hidden="true" />}
          </button>
        </DropdownMenu.Item>)}
        <DropdownMenu.Separator className="recent-folders__sep" />
        <DropdownMenu.Item className="ui-menu__item" onSelect={clear}>최근 목록 비우기</DropdownMenu.Item>
      </>} />}
    <div className="recent-folders__list" ref={list}>
      {first.map(folder => <RecentFolderChip key={folder.id} folder={folder} duplicate={hasDuplicateRecentName(folders, folder)}
        current={folder.id === currentId} onOpen={() => open(folder)} onRemove={() => remove(folder.id)} />)}
      {!reducedMotion() && departing.filter(({ folder }) => !first.some(next => next.id === folder.id)).map(({ folder, style }) => <RecentFolderChip key={folder.id} folder={folder} duplicate={false}
        current={false} onOpen={() => undefined} onRemove={() => undefined} style={style} leaving />)}
    </div>
  </div>;
}
