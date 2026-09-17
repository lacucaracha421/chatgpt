import {useMemo, useState} from 'react';
import {
  ArrowPathIcon,
  BellIcon,
  BookOpenIcon,
  FolderIcon,
  HomeIcon,
  MagnifyingGlassIcon,
  PencilSquareIcon,
  PhotoIcon,
  RectangleStackIcon,
  TagIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import './postAuthorityPreview.css';

type PreviewTab = 'home' | 'library' | 'collections' | 'catalog' | 'notes';
type PreviewAsset = {
  id: string;
  creator: string;
  time: string;
  ratio: number;
  palette: [string, string, string];
};

const creators = ['hikari', 'mika', 'asagi', 'marcus', 'nana', 'enpil', 'yume', 'aria', 'sora', 'ren'];
const ratios = [0.74, 1.48, 0.82, 1, 1.62, 0.68, 1.28, 0.9, 1.42, 0.78];
const palettes: [string, string, string][] = [
  ['#27292b', '#3d4042', '#64686a'],
  ['#25292a', '#334345', '#6e8581'],
  ['#2b292c', '#493c45', '#7f6672'],
  ['#292b31', '#394257', '#727d96'],
  ['#292a2b', '#49443c', '#807866'],
];

const assets: PreviewAsset[] = Array.from({length: 35}, (_, index) => ({
  id: `preview-${index}`,
  creator: creators[index % creators.length],
  time: `${String(17 - Math.floor(index / 5)).padStart(2, '0')}:${String(42 - (index * 13) % 43).padStart(2, '0')}`,
  ratio: ratios[index % ratios.length],
  palette: palettes[index % palettes.length],
}));

const navItems: {id: PreviewTab; label: string; icon: typeof HomeIcon}[] = [
  {id: 'home', label: 'Home', icon: HomeIcon},
  {id: 'library', label: 'Library', icon: PhotoIcon},
  {id: 'collections', label: 'Collections', icon: RectangleStackIcon},
  {id: 'catalog', label: 'Catalog', icon: BookOpenIcon},
  {id: 'notes', label: 'Notes', icon: PencilSquareIcon},
];

function Art({asset, selected = false}: {asset: PreviewAsset; selected?: boolean}) {
  const [base, mid, light] = asset.palette;
  return (
    <span
      className="pa-art"
      style={{
        aspectRatio: String(asset.ratio),
        background: `linear-gradient(148deg, ${base} 0 38%, ${mid} 38% 67%, ${light} 67% 100%)`,
      }}
    >
      <span className="pa-art-shape pa-art-shape-a"/>
      <span className="pa-art-shape pa-art-shape-b"/>
      {selected && <span className="pa-selection-wash" aria-hidden="true"/>}
      {selected && <span className="pa-selection-mark" aria-hidden="true">✓</span>}
    </span>
  );
}

function AssetTile({asset, selected, selectable, onToggle}: {
  asset: PreviewAsset;
  selected: boolean;
  selectable: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      className={`pa-asset${selected ? ' is-selected' : ''}`}
      aria-label={`${asset.creator} · ${asset.time}`}
      aria-pressed={selectable ? selected : undefined}
      onClick={selectable ? onToggle : undefined}
    >
      <Art asset={asset} selected={selected}/>
      <span className="pa-asset-caption"><span>{asset.creator}</span><time>{asset.time}</time></span>
    </button>
  );
}

function HomeView({onLibrary}: {onLibrary(): void}) {
  const discovery = [
    ['Blue Archive', '게임 · 1,684'],
    ['Reverse: 1999', '게임 · 926'],
    ['Cyberpunk', '게임 · 512'],
    ['아케비의 세일러복', '만화 · 384'],
  ] as const;
  return (
    <div className="pa-home-scroll">
      <section className="pa-home-section">
        <div className="pa-section-heading"><div><strong>최근 저장</strong><span>방금 들어온 자산</span></div><button type="button" onClick={onLibrary}>전체 보기</button></div>
        <div className="pa-recent-strip">
          {assets.slice(0, 7).map(asset => <div className="pa-recent-item" key={asset.id}><Art asset={asset}/><span>{asset.creator}</span></div>)}
        </div>
      </section>
      <section className="pa-home-section">
        <div className="pa-section-heading"><div><strong>분류 둘러보기</strong><span>시리즈와 폴더</span></div></div>
        <div className="pa-discovery-grid">
          {discovery.map(([name, meta], index) => (
            <button type="button" className="pa-discovery-card" key={name}>
              <span className="pa-discovery-art">
                {assets.slice(index * 3, index * 3 + 3).map(asset => <Art key={asset.id} asset={asset}/>) }
              </span>
              <span className="pa-discovery-copy"><strong>{name}</strong><small>{meta}</small></span>
            </button>
          ))}
        </div>
      </section>
      <section className="pa-home-section pa-revisit">
        <div className="pa-section-heading"><div><strong>다시보기</strong><span>최근의 날짜와 작가</span></div></div>
        <div className="pa-revisit-grid"><button type="button"><strong>9월 14일</strong><span>그날 저장한 74개</span></button><button type="button"><strong>hikari</strong><span>최근 자산 42개</span></button></div>
      </section>
    </div>
  );
}

function PlaceholderView({tab}: {tab: Exclude<PreviewTab, 'home' | 'library'>}) {
  const copy = {
    collections: ['Collections', '게임 · 만화 · 영화 물성은 다음 디자인 패스에서 연결'],
    catalog: ['Catalog', '현재 카탈로그 기능은 그대로 두고 새 shell에 맞춰 이식 예정'],
    notes: ['Notes', '암호화 Notes 기능은 기존 동작을 보존한 채 외형만 통합 예정'],
  }[tab];
  return <div className="pa-placeholder"><span className="pa-placeholder-mark"/><strong>{copy[0]}</strong><p>{copy[1]}</p></div>;
}

function ActivitySheet({onClose}: {onClose(): void}) {
  return (
    <div className="pa-activity-layer">
      <button type="button" className="pa-scrim" aria-label="Activity 닫기" onClick={onClose}/>
      <section className="pa-activity-sheet" role="dialog" aria-modal="true" aria-label="Activity & Sync">
        <div className="pa-sheet-handle"/>
        <header className="pa-sheet-header"><div><strong>Activity & Sync</strong><span>필요한 상태만 보여줌</span></div><button type="button" aria-label="Activity 닫기" onClick={onClose}><XMarkIcon/></button></header>
        <div className="pa-health-card">
          <div><span className="pa-health-dot"/><p><strong>문제 있음</strong><small>대기 3 · 충돌 1 · 마지막 확인 12초 전</small></p></div>
          <button type="button" className="pa-primary"><ArrowPathIcon/>지금 동기화</button>
        </div>
        <div className="pa-activity-section">
          <h3>대기 중 변경</h3>
          <div className="pa-activity-row"><span><strong>앨범 멤버십</strong><small>업로드용 · 이미지 1개 추가</small></span><em>전송 대기</em></div>
          <div className="pa-activity-row"><span><strong>분류 수정</strong><small>Marcus → Reverse: 1999</small></span><em>전송 대기</em></div>
        </div>
        <div className="pa-activity-section pa-conflict-section">
          <h3>충돌</h3>
          <div className="pa-conflict-card"><strong>앨범 멤버십이 다른 기기에서 변경됨</strong><p>내 선택은 보존되어 있습니다. 어느 상태를 사용할지 결정할 수 있습니다.</p><div><button type="button">서버 상태 사용</button><button type="button" className="pa-primary">내 선택 다시 적용</button></div></div>
        </div>
        <div className="pa-activity-section">
          <h3>백그라운드 작업</h3>
          <div className="pa-job-title"><span><ArrowPathIcon/><strong>캐릭터 분류</strong></span><small>73% · PC worker</small></div>
          <div className="pa-progress"><span/></div>
        </div>
        <div className="pa-activity-row pa-alert-row"><span><BellIcon/><span><strong>새 릴리스 1</strong><small>팔로우 중인 작품에 새 항목이 있습니다</small></span></span><em>보기</em></div>
        <footer>정상 동기화와 일반 작업 완료는 조용히 처리됨 <button type="button">상세 상태</button></footer>
      </section>
    </div>
  );
}

export function PostAuthorityPreview() {
  const [tab, setTab] = useState<PreviewTab>('library');
  const [activityOpen, setActivityOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const selectedCount = selected.size;
  const allSelected = selectedCount === assets.length;
  const contextLabel = useMemo(() => tab === 'library' ? '최근 저장' : navItems.find(item => item.id === tab)?.label ?? 'Home', [tab]);

  const changeTab = (next: PreviewTab) => {
    setTab(next);
    setSelectionMode(false);
    setSelected(new Set());
  };
  const toggleAsset = (id: string) => setSelected(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const closeSelection = () => { setSelectionMode(false); setSelected(new Set()); };
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(assets.map(asset => asset.id)));

  return (
    <div className="pa-preview">
      <header className={`pa-header${selectionMode ? ' is-selection' : ''}`}>
        {selectionMode ? (
          <><div className="pa-selection-title"><button type="button" aria-label="선택 닫기" onClick={closeSelection}><XMarkIcon/></button><strong>{selectedCount}개 선택</strong></div><button type="button" className="pa-text-button" onClick={toggleAll}>{allSelected ? '선택 해제' : '전체 선택'}</button></>
        ) : (
          <><div className="pa-brand"><span className="pa-brand-mark"/><strong>LAKOMICS</strong><span className="pa-brand-divider"/><b>{contextLabel}</b></div><div className="pa-header-actions"><button type="button" className="pa-sync-pill" aria-label="저장 대기 3" onClick={() => setActivityOpen(true)}><span/>저장 대기 3</button><button type="button" aria-label="검색"><MagnifyingGlassIcon/></button>{tab === 'library' && <button type="button" className="pa-text-button" aria-label="선택" onClick={() => setSelectionMode(true)}>선택</button>}</div></>
        )}
      </header>

      <div className="pa-context-bar">
        <div><span className="pa-context-mark"/><strong>{contextLabel}</strong>{tab === 'library' && <small>8,049개</small>}</div>
        {tab === 'library' && <span className="pa-density">촘촘하게</span>}
      </div>

      <main className="pa-main">
        {tab === 'home' && <HomeView onLibrary={() => changeTab('library')}/>} 
        {tab === 'library' && <div className="pa-library-scroll"><div className="pa-date-heading">9월 17일 · 목요일</div><div className="pa-gallery">{assets.map(asset => <AssetTile key={asset.id} asset={asset} selectable={selectionMode} selected={selected.has(asset.id)} onToggle={() => toggleAsset(asset.id)}/>)}</div></div>}
        {tab !== 'home' && tab !== 'library' && <PlaceholderView tab={tab}/>} 
      </main>

      {selectionMode ? (
        <nav className="pa-selection-actions" aria-label="선택 작업">
          <button type="button"><FolderIcon/><span>분류</span></button><button type="button"><RectangleStackIcon/><span>앨범</span></button><button type="button"><TagIcon/><span>태그</span></button><button type="button" className="is-danger"><TrashIcon/><span>휴지통</span></button>
        </nav>
      ) : (
        <nav className="pa-bottom-nav" aria-label="주요 탐색">
          {navItems.map(item => { const Icon = item.icon; return <button type="button" key={item.id} className={tab === item.id ? 'is-active' : ''} aria-current={tab === item.id ? 'page' : undefined} onClick={() => changeTab(item.id)}><Icon/><span>{item.label}</span></button>; })}
        </nav>
      )}

      {activityOpen && <ActivitySheet onClose={() => setActivityOpen(false)}/>} 
    </div>
  );
}
