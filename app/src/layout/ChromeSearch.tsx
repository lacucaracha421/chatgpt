import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useState } from "react";
import { SearchSurface } from "./SearchSurface";
import { Button } from "../shared/ui/Button";

export type ChromeSearchSpec = {
  scope: string;
  query: string;
  label: string;
  placeholder?: string;
  onApply: (query: string) => void;
};

export function ChromeSearch({ scope, query, label, placeholder, onApply }: ChromeSearchSpec) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(query);
  const begin = useCallback(() => { setDraft(query); setOpen(true); }, [query]);
  useEffect(() => setOpen(false), [scope]);
  return <SearchSurface label={label} scope={scope} active={Boolean(query.trim())} open={open} onOpen={begin} onClose={() => setOpen(false)}>
      <form className="chrome-search-form" data-chrome-search-open onSubmit={(event) => { event.preventDefault(); onApply(draft.trim()); setOpen(false); }}>
        <label className="chrome-search-field"><MagnifyingGlassIcon aria-hidden="true" />
          <input autoFocus type="search" aria-label={label} value={draft} placeholder={placeholder ?? label} onChange={(event) => setDraft(event.target.value)} onFocus={(event) => event.currentTarget.select()} />
        </label>
        <div className="ui-dialog__actions">
          {query.trim() && <Button type="button" variant="ghost" onClick={() => { onApply(""); setDraft(""); setOpen(false); }}>검색 해제</Button>}
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>취소</Button>
          <Button type="submit" variant="primary">검색</Button>
        </div>
      </form>
  </SearchSurface>;
}

export function ChromeQueryBadge({ search }: { search?: ChromeSearchSpec }) {
  if (!search?.query.trim()) return null;
  return <span className="chrome-query" title={search.query}><MagnifyingGlassIcon aria-hidden="true" /><span>{search.query}</span>
    <button type="button" aria-label="검색 해제" onClick={() => search.onApply("")}><XMarkIcon aria-hidden="true" /></button>
  </span>;
}
