import { useEffect, useState, type FormEvent } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CatalogBlockedTag, CatalogVisibilityPolicy } from "../library/types";
import { catalogCategories } from "../manga/catalogCategories";
import { Button } from "../shared/ui/Button";
import { Badge } from "../shared/ui/Badge";
import { Skeleton } from "../shared/ui/Skeleton";
import { Switch } from "../shared/ui/Switch";
import { TextInput } from "../shared/ui/TextInput";
import { Toast } from "../shared/ui/Toast";

export function CatalogVisibilitySettings() {
  const { gateway } = useLibrary();
  const [policy, setPolicy] = useState<CatalogVisibilityPolicy | null>(null);
  const [namespace, setNamespace] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void gateway.getCatalogVisibilityPolicy()
      .then((next) => { if (active) setPolicy(next); })
      .catch((loadError) => {
        if (active) {
          setLoadFailed(true);
          setError(commandErrorMessage(loadError, "카탈로그 표시 설정을 불러오지 못했습니다."));
        }
      });
    return () => { active = false; };
  }, [gateway]);

  async function retryLoad() {
    setLoadFailed(false);
    setError(null);
    try {
      setPolicy(await gateway.getCatalogVisibilityPolicy());
    } catch (loadError) {
      setLoadFailed(true);
      setError(commandErrorMessage(loadError, "카탈로그 표시 설정을 불러오지 못했습니다."));
    }
  }

  async function changeCategory(category: number, hidden: boolean) {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      setPolicy(await gateway.setCatalogCategoryHidden(category, hidden));
      setSaved(true);
    } catch (changeError) {
      setError(commandErrorMessage(changeError, "분류 표시 설정을 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function changeTag(tag: CatalogBlockedTag, blocked: boolean) {
    if (busy) return;
    setBusy(true);
    setSaved(false);
    setError(null);
    try {
      setPolicy(await gateway.setCatalogTagBlocked(tag, blocked));
      setSaved(true);
      if (blocked) {
        setNamespace("");
        setValue("");
      }
    } catch (changeError) {
      setError(commandErrorMessage(changeError, "태그 차단 설정을 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  function addTag(event: FormEvent) {
    event.preventDefault();
    const tag = { namespace: namespace.trim(), value: value.trim() };
    if (!tag.namespace || !tag.value) return;
    void changeTag(tag, true);
  }

  return <section className="catalog-visibility-settings" aria-labelledby="catalog-visibility-title">
    <h4 id="catalog-visibility-title">검색 결과 숨김</h4>
    {busy ? <p role="status">저장 중…</p> : saved && <p role="status">저장됨</p>}
    {error && <Toast tone="error" onDismiss={() => setError(null)}>{error}</Toast>}
    {!policy ? loadFailed
      ? <Button size="sm" onClick={() => void retryLoad()}>다시 시도</Button>
      : <Skeleton className="settings-view__skeleton" label="카탈로그 표시 설정을 불러오는 중" /> : <>
      <fieldset className="catalog-visibility-settings__categories" disabled={busy}>
        <legend>숨길 분류</legend>
        <div>
          {catalogCategories.map((category) => <label className="settings-view__category-row" key={category.id}>
            <span>{category.label}</span>
            <Switch aria-label={`${category.label} 숨기기`} checked={policy.hiddenCategories.includes(category.id)} onChange={(event) => void changeCategory(category.id, event.target.checked)} />
          </label>)}
        </div>
      </fieldset>
      <div className="catalog-visibility-settings__tags">
        <span className="catalog-visibility-settings__label">차단 태그</span>
        <form className="catalog-visibility-settings__tag-form" onSubmit={addTag}>
          <TextInput aria-label="차단 태그 종류" autoComplete="off" placeholder="artist" value={namespace} disabled={busy} onChange={(event) => setNamespace(event.target.value)} />
          <TextInput aria-label="차단 태그 값" autoComplete="off" placeholder="태그 값" value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} />
          <Button size="sm" variant="secondary" type="submit" disabled={busy || !namespace.trim() || !value.trim()}>태그 차단</Button>
        </form>
        {policy.blockedTags.length === 0 ? <p>차단한 태그가 없습니다.</p> : <ul>
          {policy.blockedTags.map((tag) => <li key={`${tag.namespace}\0${tag.value}`}>
            <Badge>{tag.namespace}:{tag.value}</Badge>
            <Button size="sm" variant="quiet" disabled={busy} aria-label={`${tag.namespace}:${tag.value} 차단 해제`} onClick={() => void changeTag(tag, false)}>해제</Button>
          </li>)}
        </ul>}
      </div>
    </>}
  </section>;
}
