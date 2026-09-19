import {useEffect, useRef, useState} from 'react';
import {ArrowTopRightOnSquareIcon, CheckIcon, ClipboardDocumentIcon, XMarkIcon} from '@heroicons/react/24/outline';
import {Button, IconButton} from './ui';
import type {Asset} from './types';
import {dateLabel, durationLabel} from './model';
import {errorText, native} from './transport';

/**
 * Every row renders a field the mobile Asset actually carries; a value the device does
 * not have is omitted rather than placeholdered. The copyable summary is generated from
 * these same rows, so it cannot drift from what the panel shows.
 */
export type InfoField = {key: string; label: string; value: string};

/** `@handle` once, regardless of whether the stored handle already carries the sigil. */
export function handleLabel(handle: string): string {
  const trimmed = handle.trim();
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

/** The host and path PC shows for a source link, so the row reads as a site, not a query string. */
export function sourceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Only this client's own `openExternal` accepts these; anything else is not offered as a link. */
export function openableSource(url: string | undefined): url is string {
  return !!url && /^https?:\/\//.test(url);
}

function sourcePublishedLabel(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString('ko-KR', {year: 'numeric', month: '2-digit', day: '2-digit'}) : value;
}

export function creatorText(asset: Asset): string {
  const name = asset.creator_name?.trim(), handle = asset.creator_handle?.trim();
  if (name && handle) return name === handle ? name : `${name}\n${handleLabel(handle)}`;
  return name || (handle ? handleLabel(handle) : '');
}

/** PC formats bytes as B/KB/MB/GB; mobile keeps the same thresholds so sizes compare directly. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1073741824) return `${Math.round(bytes / 1048576)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

/**
 * The rows the panel shows, in the order it shows them. `file` marks the technical
 * rows that also carry the copyable metadata summary, so the summary cannot drift
 * from what is on screen: it is generated from these same values.
 */
export function infoFields(asset: Asset): {rows: (InfoField & {section: 'source' | 'file'; file?: boolean})[]; heading: string} {
  const kind = asset.kind === 'video' ? '영상' : '이미지';
  const source = openableSource(asset.source_url) ? asset.source_url : undefined;
  const creator = creatorText(asset);
  const rows: (InfoField & {section: 'source' | 'file'; file?: boolean})[] = [];
  if (creator) rows.push({key: 'creator', label: '작가', value: creator, section: 'source'});
  if (source) rows.push({key: 'source', label: '출처', value: sourceLabel(source), section: 'source'});
  // `source_published_at` is the only field that means a publication date. `created_at`
  // and `collected_at` are this library's own storage times, so neither may stand in for
  // it: when the server sends no publication time, the row is absent rather than wrong.
  if (asset.source_published_at) rows.push({key: 'published', label: '게시 시각', value: sourcePublishedLabel(asset.source_published_at), section: 'source'});
  rows.push({key: 'collected', label: asset.pending ? '수집 요청' : '수집일', value: dateLabel(asset), section: 'file', file: true});
  if (asset.width && asset.height) rows.push({key: 'dimensions', label: '해상도', value: `${asset.width.toLocaleString()} × ${asset.height.toLocaleString()}`, section: 'file', file: true});
  const duration = durationLabel(asset);
  if (duration) rows.push({key: 'duration', label: '재생 시간', value: duration, section: 'file', file: true});
  rows.push({key: 'format', label: '형식', value: asset.content_type || kind, section: 'file', file: true});
  if (asset.size_bytes != null) rows.push({key: 'size', label: '크기', value: sizeLabel(asset.size_bytes), section: 'file', file: true});
  return {rows, heading: asset.creator_name?.trim() || asset.creator_handle?.trim() || kind};
}

const SECTIONS: {key: 'source' | 'file'; title: string}[] = [{key: 'source', title: '출처'}, {key: 'file', title: '파일'}];

/** `label: value` per line, covering exactly the 파일 정보 the panel shows. */
export function summaryText(asset: Asset): string {
  return infoFields(asset).rows.filter(row => row.file).map(row => `${row.label}: ${row.value.replace(/\n/g, ' ')}`).join('\n');
}

/**
 * The clipboard has two providers and they fail for different reasons, so neither failure
 * is swallowed. The bridge is the only path that works inside the APK; the browser API
 * covers the development preview.
 */
async function writeClipboard(text: string): Promise<void> {
  if (window.LakomicsNative) return native('copyText', {text}, undefined).then(() => undefined);
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error('이 환경에서는 복사할 수 없습니다.');
}

/**
 * Compact media-first information panel for the Viewer.
 *
 * Open/closed state and mutual exclusion with the Album and Classification editors stay in
 * `Viewer`, so those three overlays keep one owner.
 */
export function ViewerInfo({asset, mediaError = '', onClose}: {asset: Asset; mediaError?: string; onClose(): void}) {
  const [status, setStatus] = useState<{kind: 'copied' | 'failed'; label: string} | null>(null);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  // A copy reply is only honoured for the exact request that asked for it. The snapshot is
  // a plain integer taken per request, and unmounting invalidates it, so a late or
  // cancelled reply cannot surface as another Asset's result.
  const lifetime = useRef({assetId: asset.id, generation: 0});
  lifetime.current.assetId = asset.id;
  useEffect(() => () => {lifetime.current.generation++;}, []);
  const {rows, heading} = infoFields(asset);
  const source = openableSource(asset.source_url) ? asset.source_url : undefined;

  useEffect(() => {setStatus(null); setCopied(''); setBusy(false);}, [asset.id]);
  useEffect(() => {
    if (status?.kind !== 'copied') return;
    const timer = window.setTimeout(() => {setStatus(null); setCopied('');}, 2000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const current = (snapshot: {assetId: string; generation: number}) => lifetime.current.assetId === snapshot.assetId && lifetime.current.generation === snapshot.generation;
  const copy = async (text: string, label: string) => {
    const snapshot = {assetId: lifetime.current.assetId, generation: lifetime.current.generation};
    setBusy(true); setStatus(null); setCopied('');
    try {
      await writeClipboard(text);
      if (!current(snapshot)) return;
      setStatus({kind: 'copied', label}); setCopied(label);
    } catch (reason) {
      if (!current(snapshot)) return;
      setStatus({kind: 'failed', label: errorText(reason) || '복사하지 못했습니다.'});
    } finally {
      if (current(snapshot)) setBusy(false);
    }
  };
  const openSource = async () => {
    if (!source) return;
    const snapshot = {assetId: lifetime.current.assetId, generation: lifetime.current.generation};
    setStatus(null);
    try {
      await native('openExternal', {url: source});
    } catch (reason) {
      if (current(snapshot)) setStatus({kind: 'failed', label: errorText(reason) || '출처를 열지 못했습니다.'});
    }
  };

  const creator = creatorText(asset);
  const copiedLabel = (label: string) => copied === label;

  return <section className="viewer-info" aria-label="미디어 정보">
    <header className="viewer-info-heading">
      <span className="viewer-info-kind">{asset.kind === 'video' ? 'VIDEO' : 'IMAGE'}</span>
      <h2>{heading}</h2>
      <IconButton label="정보 닫기" icon={XMarkIcon} onClick={onClose}/>
    </header>
    <div className="viewer-info-body">
      {SECTIONS.map(section => {
        const sectionRows = rows.filter(row => row.section === section.key);
        if (!sectionRows.length) return null;
        return <dl key={section.key} className="viewer-info-group">
          <dt className="viewer-info-group-title">{section.title}</dt>
          {sectionRows.map(row => <div key={row.key} className="viewer-info-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>)}
        </dl>;
      })}
      <div className="viewer-info-actions">
        {creator && <Button variant="ghost" disabled={busy} onClick={() => void copy(creator, '작가')}>
          {copiedLabel('작가') ? <CheckIcon/> : <ClipboardDocumentIcon/>}작가 복사
        </Button>}
        {source && <Button variant="ghost" disabled={busy} onClick={() => void copy(source, '출처')}>
          {copiedLabel('출처') ? <CheckIcon/> : <ClipboardDocumentIcon/>}출처 복사
        </Button>}
        <Button variant="ghost" disabled={busy} onClick={() => void copy(summaryText(asset), '파일 정보')}>
          {copiedLabel('파일 정보') ? <CheckIcon/> : <ClipboardDocumentIcon/>}파일 정보 복사
        </Button>
        {source && <Button onClick={() => void openSource()}>
          <ArrowTopRightOnSquareIcon/>출처 열기
        </Button>}
      </div>
      {status && <p className={`viewer-info-copy ${status.kind}`} role="alert">
        {status.kind === 'copied' ? `${status.label} 정보를 클립보드에 복사했습니다.` : status.label}
      </p>}
      {mediaError && <p className="viewer-info-media-error" role="status">{mediaError}</p>}
    </div>
  </section>;
}
