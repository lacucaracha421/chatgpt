import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";

/** A view's plain text search; the 찾기 palette applies typed text through `onApply`. */
export type ChromeSearchSpec = {
  scope: string;
  query: string;
  label: string;
  placeholder?: string;
  onApply: (query: string) => void;
};

export function ChromeQueryBadge({ search }: { search?: ChromeSearchSpec }) {
  if (!search?.query.trim()) return null;
  return <span className="chrome-query" aria-description={search.query}><MagnifyingGlassIcon aria-hidden="true" /><span>{search.query}</span>
    <button type="button" aria-label="검색 해제" onClick={() => search.onApply("")}><XMarkIcon aria-hidden="true" /></button>
  </span>;
}
