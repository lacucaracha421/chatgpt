import { useEffect, useState, type FormEvent } from "react";
import { useLibrary } from "../library/LibraryContext";
import { commandErrorMessage } from "../library/errorMessage";
import type { CatalogBlockedTag, CatalogVisibilityPolicy } from "../library/types";
import { catalogCategories } from "../manga/catalogCategories";
import { Button } from "../shared/ui/Button";
import { Skeleton } from "../shared/ui/Skeleton";
import { Toast } from "../shared/ui/Toast";
import { Toggle } from "../shared/ui/Toggle";

export function CatalogVisibilitySettings() {
  const { gateway } = useLibrary();
  const [policy, setPolicy] = useState<CatalogVisibilityPolicy | null>(null);
  const [namespace, setNamespace] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    try {
      setPolicy(await gateway.setCatalogCategoryHidden(category, hidden));
    } catch (changeError) {
      setError(commandErrorMessage(changeError, "분류 표시 설정을 저장하지 못했습니다."));
    } finally {
      setBusy(false);
    }
  }

  async function changeTag(tag: CatalogBlockedTag, blocked: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setPolicy(await gateway.setCatalogTagBlocked(tag, blocked));
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
    <p className="settings-view__row-note">선택한 분류나 정확히 일치하는 태그를 기본 검색 결과에서 숨깁니다. 저장된 설정은 백업과 복원에 포함됩니다.</p>
    {error && <Toast tone="error" onDismiss={() => setError(null)}>{error}</Toast>}
    {!policy ? loadFailed
      ? <Button size="sm" onClick={() => void retryLoad()}>다시 시도</Button>
      : <Skeleton className="settings-view__skeleton" label="카탈로그 표시 설정을 불러오는 중" /> : <>
      <fieldset className="catalog-visibility-settings__categories" disabled={busy}>
        <legend>숨길 분류</legend>
        <div>
          {catalogCategories.map((category) => <Toggle
            key={category.id}
            checked={policy.hiddenCategories.includes(category.id)}
            onChange={(event) => void changeCategory(category.id, event.target.checked)}
          >{category.label} 숨기기</Toggle>)}
        </div>
      </fieldset>
      <div className="catalog-visibility-settings__tags">
        <span className="catalog-visibility-settings__label">차단 태그</span>
        <form className="catalog-visibility-settings__tag-form" onSubmit={addTag}>
          <input className="settings-view__token" aria-label="차단 태그 네임스페이스" autoComplete="off" placeholder="artist" value={namespace} disabled={busy} onChange={(event) => setNamespace(event.target.value)} />
          <input className="settings-view__token" aria-label="차단 태그 값" autoComplete="off" placeholder="태그 값" value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} />
          <Button size="sm" type="submit" disabled={busy || !namespace.trim() || !value.trim()}>태그 차단</Button>
        </form>
        {policy.blockedTags.length === 0 ? <p>차단한 태그가 없습니다.</p> : <ul>
          {policy.blockedTags.map((tag) => <li key={`${tag.namespace}\0${tag.value}`}>
            <code>{tag.namespace}:{tag.value}</code>
            <Button size="sm" disabled={busy} aria-label={`${tag.namespace}:${tag.value} 차단 해제`} onClick={() => void changeTag(tag, false)}>해제</Button>
          </li>)}
        </ul>}
      </div>
    </>}
  </section>;
}
