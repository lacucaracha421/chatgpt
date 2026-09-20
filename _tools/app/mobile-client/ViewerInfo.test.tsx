import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Asset} from './types';
const mocks = vi.hoisted(() => ({native: vi.fn()}));
vi.mock('./transport', () => ({
  native: mocks.native,
  errorText: (reason: unknown) => reason instanceof Error ? reason.message.slice(0, 180) : '연결을 확인한 뒤 다시 시도해 주세요.',
}));
import {ViewerInfo, creatorText, infoFields, openableSource, sectionHasVisibleTitle, sizeLabel, sourceLabel, summaryText} from './ViewerInfo';

/** A complete Asset, so a test states only the fields it is actually about. */
const asset = (overrides: Partial<Asset> = {}): Asset => ({
  id: 'a', kind: 'image', content_type: 'image/webp', size_bytes: 483217,
  width: 1200, height: 800, collected_at: '2026-09-06T12:00:00Z',
  creator_name: '서유진', creator_handle: 'bluealex1203', source_url: 'https://example.com/posts/42',
  ...overrides,
});
const clipboard = {writeText: vi.fn()};

beforeEach(() => {
  mocks.native.mockReset();
  clipboard.writeText.mockReset();
  mocks.native.mockResolvedValue({});
  clipboard.writeText.mockResolvedValue(undefined);
  Object.defineProperty(window, 'LakomicsNative', {configurable: true, value: undefined});
  Object.defineProperty(navigator, 'clipboard', {configurable: true, value: clipboard});
});
afterEach(cleanup);

describe('ViewerInfo field projection', () => {
  it('renders only fields the Asset actually carries', () => {
    const {rows} = infoFields(asset());
    expect(rows.map(row => row.label)).toEqual(['작가', '출처', '수집일', '해상도', '형식', '크기']);
    expect(rows.map(row => row.value)).toContain('1,200 × 800');
    expect(rows.map(row => row.value)).toContain('472 KB');
  });
  it('omits unknown dimensions, size and duration instead of inventing them', () => {
    const {rows} = infoFields({id: 'a', kind: 'video', preview: 'x'});
    expect(rows.map(row => row.label)).toEqual(['수집일', '형식']);
    expect(rows.map(row => row.value)).toContain('영상');
  });
  it('shows a video duration including a legitimate zero', () => {
    expect(infoFields({id: 'v', kind: 'video', duration_ms: 0}).rows.map(row => row.value)).toContain('0:00');
    expect(infoFields({id: 'v', kind: 'video', duration_ms: 3_725_000}).rows.map(row => row.value)).toContain('1:02:05');
    expect(infoFields({id: 'v', kind: 'video', duration_ms: null}).rows.map(row => row.label)).not.toContain('재생 시간');
  });
  it('keeps the post time distinct from the imported date', () => {
    const {rows} = infoFields(asset({created_at: '2026-08-01T00:00:00Z', source_published_at: '2026-07-01T00:00:00Z'}));
    const posted = rows.find(row => row.label === '게시 시각');
    const expected = new Date('2026-07-01T00:00:00Z').toLocaleDateString('ko-KR', {year: 'numeric', month: '2-digit', day: '2-digit'});
    expect(posted?.value).toBe(expected);
    expect(rows.filter(row => row.label === '수집일')).toHaveLength(1);
  });
  it('never presents a storage time as the publication time', () => {
    // `created_at`/`collected_at` are this library's own storage times, not publication
    // dates, so without `source_published_at` the row must be absent rather than wrong.
    for (const candidate of [
      {created_at: '2026-08-01T00:00:00Z'},
      {collected_at: '2026-08-01T00:00:00Z'},
      {created_at: '2026-08-01T00:00:00Z', collected_at: '2026-08-02T00:00:00Z'},
      {source_published_at: ''},
      {source_published_at: null},
    ]) {
      const {rows} = infoFields(asset(candidate));
      expect(rows.map(row => row.label)).not.toContain('게시 시각');
    }
    const {rows} = infoFields(asset({created_at: '2026-08-01T00:00:00Z', source_published_at: '2026-07-01T00:00:00Z'}));
    expect(rows.filter(row => row.label === '게시 시각')).toHaveLength(1);
  });
  it('labels a pending capture without pretending it has a date', () => {
    const {rows} = infoFields({id: 'p', kind: 'image', pending: true});
    expect(rows.map(row => row.label)).toContain('수집 요청');
    expect(rows.map(row => row.value)).toContain('날짜 없음');
  });
  it('formats creator, handle, source and size the way the rows need', () => {
    expect(creatorText(asset())).toBe('서유진\n@bluealex1203');
    // Only the handle is present, so the sigil is added once.
    expect(creatorText({id: 'a', kind: 'image', creator_handle: 'bluealex1203'})).toBe('@bluealex1203');
    // The same string in both fields collapses to a single line.
    expect(creatorText({id: 'a', kind: 'image', creator_name: 'bluealex1203', creator_handle: 'bluealex1203'})).toBe('bluealex1203');
    // A handle that already carries the sigil is not double-prefixed.
    expect(creatorText({id: 'a', kind: 'image', creator_handle: '@서유진'})).toBe('@서유진');
    expect(creatorText({id: 'a', kind: 'image'})).toBe('');
    expect(sourceLabel('https://example.com/posts/42?token=secret')).toBe('example.com/posts/42');
    expect(sourceLabel('not a url')).toBe('not a url');
    expect(openableSource('javascript:alert(1)')).toBe(false);
    expect(openableSource('https://example.com/a')).toBe(true);
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(483217)).toBe('472 KB');
    expect(sizeLabel(9_700_000_000)).toBe('9.0 GB');
  });
  it('builds the copy summary from the same values the file rows show', () => {
    expect(summaryText(asset())).toBe('수집일: 2026. 09. 06.\n해상도: 1,200 × 800\n형식: image/webp\n크기: 472 KB');
  });
});

describe('ViewerInfo section headings', () => {
  it('suppresses a heading that would only repeat the row beneath it', () => {
    // With no creator, 출처 is both this section's title and its first row label.
    const rows = infoFields({id: 'a', kind: 'image', source_url: 'https://example.com/posts/42'});
    expect(sectionHasVisibleTitle(rows.rows.filter(row => row.section === 'source'), 'source')).toBe(false);
    // The file section always starts with 수집일, so its heading still earns its space.
    expect(sectionHasVisibleTitle(rows.rows.filter(row => row.section === 'file'), 'file')).toBe(true);
  });
  it('keeps the heading when the first row is not that title', () => {
    // 작가 comes first here, so the 출처 heading still tells the reader what the section is.
    const rows = infoFields(asset()).rows.filter(row => row.section === 'source');
    expect(rows[0].label).toBe('작가');
    expect(sectionHasVisibleTitle(rows, 'source')).toBe(true);
  });
  it('renders no empty heading for a section with no rows', () => {
    expect(sectionHasVisibleTitle([], 'source')).toBe(false);
  });
});

describe('ViewerInfo panel', () => {
  it('is media-first and compact: heading, sections, one explicit close control', () => {
    render(<ViewerInfo asset={asset()} onClose={() => {}}/>);
    expect(screen.getByRole('heading', {level: 2}).textContent).toBe('서유진');
    expect(screen.getByText('IMAGE')).toBeTruthy();
    expect(screen.getByRole('button', {name: '정보 닫기'})).toBeTruthy();
    // 작가 leads this fixture's 출처 section, so the heading stays distinct from the rows.
    expect(screen.getAllByText('출처')).toHaveLength(2);
    expect(screen.getByText('작가')).toBeTruthy();
    expect(screen.getByText('example.com/posts/42')).toBeTruthy();
    expect(screen.getByText('파일')).toBeTruthy();
  });
  it('drops the 출처 heading when it would be the section\'s first label', () => {
    // No creator is known, so 출처 is both the section title and its first row.
    const {container} = render(<ViewerInfo asset={{id: 'a', kind: 'image', source_url: 'https://example.com/posts/42'}} onClose={() => {}}/>);
    const headings = [...container.querySelectorAll('.viewer-info-group-title')].map(node => node.textContent);
    expect(headings).toEqual(['파일']);
    expect(screen.getAllByText('출처')).toHaveLength(1);
  });
  it('closes through the labelled control', () => {
    const close = vi.fn();
    render(<ViewerInfo asset={asset()} onClose={close}/>);
    fireEvent.click(screen.getByRole('button', {name: '정보 닫기'}));
    expect(close).toHaveBeenCalledOnce();
  });
  it('copies creator, source and metadata summary through the native bridge', async () => {
    // The bridge must be present, otherwise the panel correctly prefers the browser API.
    Object.defineProperty(window, 'LakomicsNative', {configurable: true, value: {request: vi.fn(), cancel: vi.fn()}});
    render(<ViewerInfo asset={asset()} onClose={() => {}}/>);
    fireEvent.click(screen.getByRole('button', {name: '작가 복사'}));
    // The first argument is the operation name and the payload the caller asked for.
    await waitFor(() => expect(mocks.native.mock.calls[0]?.[1]).toEqual({text: '서유진\n@bluealex1203'}));
    expect(mocks.native.mock.calls[0]?.[0]).toBe('copyText');
    expect(clipboard.writeText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: '출처 복사'}));
    await waitFor(() => expect(mocks.native.mock.calls[1]?.[1]).toEqual({text: 'https://example.com/posts/42'}));
    fireEvent.click(screen.getByRole('button', {name: '파일 정보 복사'}));
    await waitFor(() => expect(mocks.native.mock.calls[2]?.[1]).toEqual({text: summaryText(asset())}));
    expect(await screen.findByText('파일 정보 정보를 클립보드에 복사했습니다.')).toBeTruthy();
  });
  it('labels the summary action as the file information it actually copies', () => {
    const {rows} = infoFields(asset());
    const summaryRows = rows.filter(row => row.file);
    expect(summaryText(asset()).split('\n')).toHaveLength(summaryRows.length);
    expect(summaryText(asset())).not.toContain('출처');
    expect(summaryText(asset())).not.toContain('작가');
  });
  it('offers no copy or open action for a field the Asset does not have', () => {
    render(<ViewerInfo asset={{id: 'a', kind: 'image'}} onClose={() => {}}/>);
    expect(screen.queryByRole('button', {name: '작가 복사'})).toBeNull();
    expect(screen.queryByRole('button', {name: '출처 복사'})).toBeNull();
    expect(screen.queryByRole('button', {name: '출처 열기'})).toBeNull();
    // The metadata summary is always available because the file rows always exist.
    expect(screen.getByRole('button', {name: '파일 정보 복사'})).toBeTruthy();
  });
  it('reports a copy failure in its own live region, not as a media error', async () => {
    // A native bridge is present, so the copy goes through it and its failure is what
    // the panel must show.
    Object.defineProperty(window, 'LakomicsNative', {configurable: true, value: {request: vi.fn(), cancel: vi.fn()}});
    mocks.native.mockRejectedValue(new Error('지원하지 않는 요청입니다.'));
    render(<ViewerInfo asset={asset()} onClose={() => {}}/>);
    fireEvent.click(screen.getByRole('button', {name: '파일 정보 복사'}));
    const alert = await waitFor(() => {
      const node = document.querySelector('.viewer-info-copy.failed');
      if (!node) throw new Error('copy failure is not reported yet');
      return node;
    });
    expect(alert.textContent).toBe('지원하지 않는 요청입니다.');
    expect(alert.getAttribute('role')).toBe('alert');
  });
  it('shows media failure as a separate, quieter line', () => {
    const {container} = render(<ViewerInfo asset={asset()} mediaError="이미지를 표시하지 못했습니다." onClose={() => {}}/>);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(container.querySelector('.viewer-info-media-error')?.textContent).toBe('이미지를 표시하지 못했습니다.');
  });
  it('uses the browser clipboard only when no native bridge is present', async () => {
    Object.defineProperty(window, 'LakomicsNative', {configurable: true, value: {request: vi.fn(), cancel: vi.fn()}});
    const {unmount} = render(<ViewerInfo asset={asset()} onClose={() => {}}/>);
    fireEvent.click(screen.getByRole('button', {name: '파일 정보 복사'}));
    await waitFor(() => expect(mocks.native).toHaveBeenCalledOnce());
    expect(clipboard.writeText).not.toHaveBeenCalled();
    expect(mocks.native.mock.calls[0][0]).toBe('copyText');
    unmount();
  });
  it('falls back to the browser clipboard and surfaces its rejection', async () => {
    clipboard.writeText.mockRejectedValue(new Error('브라우저가 복사를 허용하지 않았습니다.'));
    render(<ViewerInfo asset={asset()} onClose={() => {}}/>);
    fireEvent.click(screen.getByRole('button', {name: '파일 정보 복사'}));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(summaryText(asset())));
    expect((await screen.findByRole('alert')).textContent).toBe('브라우저가 복사를 허용하지 않았습니다.');
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it('does not let a late copy reply report success for a different Asset', async () => {
    // The bridge is what is being awaited here, so it must be the selected provider.
    Object.defineProperty(window, 'LakomicsNative', {configurable: true, value: {request: vi.fn(), cancel: vi.fn()}});
    let finish!: (value: unknown) => void;
    mocks.native.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    const {rerender} = render(<ViewerInfo asset={asset()} onClose={() => {}}/>);
    fireEvent.click(screen.getByRole('button', {name: '파일 정보 복사'}));
    await waitFor(() => expect(mocks.native).toHaveBeenCalledOnce());
    rerender(<ViewerInfo asset={asset({id: 'b', creator_name: '다른 작가'})} onClose={() => {}}/>);
    finish({});
    await waitFor(() => expect(screen.getByRole('heading', {level: 2}).textContent).toBe('다른 작가'));
    expect(screen.queryByText(/복사했습니다/)).toBeNull();
    expect(document.querySelector('.viewer-info-copy')).toBeNull();
  });
  it('drops a stale copy failure after the Asset changes', async () => {
    Object.defineProperty(window, 'LakomicsNative', {configurable: true, value: {request: vi.fn(), cancel: vi.fn()}});
    mocks.native.mockRejectedValue(new Error('복사하지 못했습니다.'));
    const {rerender} = render(<ViewerInfo asset={asset()} onClose={() => {}}/>);
    fireEvent.click(screen.getByRole('button', {name: '파일 정보 복사'}));
    await waitFor(() => expect(document.querySelector('.viewer-info-copy.failed')).toBeTruthy());
    rerender(<ViewerInfo asset={asset({id: 'b'})} onClose={() => {}}/>);
    await waitFor(() => expect(document.querySelector('.viewer-info-copy')).toBeNull());
  });
  it('ignores a copy reply that arrives after the panel unmounted', async () => {
    Object.defineProperty(window, 'LakomicsNative', {configurable: true, value: {request: vi.fn(), cancel: vi.fn()}});
    let finish!: (value: unknown) => void;
    mocks.native.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
    const {unmount} = render(<ViewerInfo asset={asset()} onClose={() => {}}/>);
    fireEvent.click(screen.getByRole('button', {name: '파일 정보 복사'}));
    await waitFor(() => expect(mocks.native).toHaveBeenCalledOnce());
    unmount();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    finish({});
    await new Promise(resolve => setTimeout(resolve, 0));
    // A late reply must not reach a removed tree; React would report a state update on an
    // unmounted component, so silence here is itself the assertion.
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
  it('ignores a copy failure that arrives after the panel unmounted', async () => {
    Object.defineProperty(window, 'LakomicsNative', {configurable: true, value: {request: vi.fn(), cancel: vi.fn()}});
    let reject!: (reason: unknown) => void;
    mocks.native.mockImplementation(() => new Promise((_resolve, rejectCall) => {reject = rejectCall;}));
    const {unmount} = render(<ViewerInfo asset={asset()} onClose={() => {}}/>);
    fireEvent.click(screen.getByRole('button', {name: '파일 정보 복사'}));
    await waitFor(() => expect(mocks.native).toHaveBeenCalledOnce());
    unmount();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    reject(new Error('지원하지 않는 요청입니다.'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
  it('reports a failed 출처 열기 instead of swallowing it', async () => {
    Object.defineProperty(window, 'LakomicsNative', {configurable: true, value: {request: vi.fn(), cancel: vi.fn()}});
    mocks.native.mockRejectedValue(new Error('연결을 확인한 뒤 다시 시도해 주세요.'));
    render(<ViewerInfo asset={asset()} onClose={() => {}}/>);
    fireEvent.click(screen.getByRole('button', {name: '출처 열기'}));
    await waitFor(() => expect(mocks.native.mock.calls[0]?.[1]).toEqual({url: 'https://example.com/posts/42'}));
    expect(mocks.native.mock.calls[0]?.[0]).toBe('openExternal');
    const alert = await waitFor(() => {
      const node = document.querySelector('.viewer-info-copy.failed');
      if (!node) throw new Error('open failure is not reported yet');
      return node;
    });
    expect(alert.textContent).toBe('연결을 확인한 뒤 다시 시도해 주세요.');
  });
});
