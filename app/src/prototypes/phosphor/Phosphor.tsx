import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { TerritoryGame, TARGET, type Direction } from './engine';
import { ArcadeRenderer, ArcadeSound } from './presentation';
import { DEMOS } from './art';
import './phosphor.css';

type Asset = { name: string; url: string };
type Props = { selectedAssetUrls?: string[]; onExit?: () => void };
const directionKeys: Record<string, Direction> = { ArrowUp: 'up', w: 'up', ArrowDown: 'down', s: 'down', ArrowLeft: 'left', a: 'left', ArrowRight: 'right', d: 'right' };
const pad: [Direction, string][] = [['up', '↑'], ['left', '←'], ['down', '↓'], ['right', '→']];

/** Isolated, in-memory arcade prototype. URLs are the only Lakomics integration seam. */
export function Phosphor({ selectedAssetUrls, onExit }: Props) {
  const [assets, setAssets] = useState<Asset[]>(() => selectedAssetUrls?.length ? selectedAssetUrls.map((url, i) => ({ url, name: `SELECTED IMAGE ${String(i + 1).padStart(2, '0')}` })) : DEMOS);
  const [stage, setStage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [muted, setMuted] = useState(false);
  const [aspect, setAspect] = useState(4 / 3);
  const [help, setHelp] = useState(false);
  const [aiming, setAiming] = useState(false);
  const [, repaint] = useState(0);
  const [total, setTotal] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const game = useRef(new TerritoryGame());
  const art = useRef<HTMLImageElement | null>(null);
  const renderer = useRef<ArcadeRenderer | null>(null);
  const sound = useRef<ArcadeSound | null>(null);
  const keys = useRef<string[]>([]);
  const touchDirection = useRef<Direction | undefined>(undefined);
  const objectUrls = useRef<string[]>([]);
  const force = useCallback(() => repaint(v => v + 1), []);
  const clearInput = useCallback(() => { keys.current = []; touchDirection.current = undefined; }, []);
  const g = game.current;

  useEffect(() => {
    const audio = new ArcadeSound(); sound.current = audio;
    renderer.current = new ArcadeRenderer();
    return () => { audio.dispose(); objectUrls.current.forEach(url => URL.revokeObjectURL(url)); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false); setError(''); setAiming(false); clearInput(); art.current = null;
    game.current = new TerritoryGame(4 / 3, stage); force();
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const ratio = image.naturalWidth / image.naturalHeight;
      if (!Number.isFinite(ratio) || ratio <= 0) { setError('이 이미지는 크기를 읽을 수 없습니다. 다른 이미지를 선택해 주세요.'); return; }
      art.current = image; game.current = new TerritoryGame(ratio, stage);
      setAspect(Math.max(.35, Math.min(2.8, ratio))); setLoaded(true); force();
    };
    image.onerror = () => { if (!cancelled) setError('이미지를 열 수 없습니다. 다른 이미지를 선택하거나 다음 스테이지로 넘어가세요.'); };
    image.src = assets[stage].url;
    return () => { cancelled = true; image.onload = null; image.onerror = null; };
  }, [assets, stage, revision, clearInput, force]);

  const start = useCallback(() => {
    if (!loaded || error) return;
    sound.current?.unlock(); sound.current?.tone(523, .12); game.current.start();
    setHelp(false); setAiming(false); clearInput(); canvas.current?.focus({ preventScroll: true }); force();
  }, [loaded, error, clearInput, force]);
  const pause = useCallback(() => { game.current.pause(); clearInput(); force(); }, [clearInput, force]);
  const restart = useCallback(() => { setRevision(v => v + 1); setHelp(false); clearInput(); }, [clearInput]);
  const exit = () => {
    if (onExit) { game.current.phase = 'paused'; clearInput(); onExit(); }
    else { setTotal(0); restart(); }
  };
  const next = () => {
    if (game.current.phase === 'clear') setTotal(v => v + game.current.score);
    if (stage + 1 < assets.length) setStage(stage + 1);
    else { setTotal(0); setStage(0); setRevision(v => v + 1); }
    setHelp(false); clearInput();
  };

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === ' ' && event.target instanceof HTMLButtonElement) return;
      if (directionKeys[key] || key === ' ') event.preventDefault();
      if (!event.repeat) {
        if (key === 'Enter' && (game.current.phase === 'ready')) { start(); return; }
        if (key === 'Escape' || key === 'p') { pause(); return; }
        if (key === 'r') { restart(); return; }
        if (key === 'x') { game.current.arm(); force(); return; }
        if (aiming && directionKeys[key]) {
          const d = directionKeys[key]; const p = game.current.focus;
          game.current.setFocus(p.x + (d === 'left' ? -1 : d === 'right' ? 1 : 0), p.y + (d === 'up' ? -1 : d === 'down' ? 1 : 0));
          force(); return;
        }
        if (directionKeys[key]) game.current.queueMove(directionKeys[key], keys.current.includes(' ') || event.shiftKey);
        if (!keys.current.includes(key)) keys.current.push(key);
        force();
      }
    };
    const up = (event: KeyboardEvent) => { keys.current = keys.current.filter(k => k !== (event.key.length === 1 ? event.key.toLowerCase() : event.key)); };
    const blur = () => { if (game.current.phase === 'playing') game.current.pause(); clearInput(); force(); };
    const visibility = () => { if (document.hidden) blur(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); };
  }, [start, pause, restart, clearInput, force, aiming]);

  useEffect(() => {
    let frame = 0, last = performance.now(), uiClock = 0;
    const animate = (now: number) => {
      const dt = Math.min((now - last) / 1000, .05); last = now;
      const directions = keys.current.map(k => directionKeys[k]).filter(Boolean);
      const direction = touchDirection.current ?? directions[directions.length - 1];
      const current = game.current;
      current.step(dt, direction, keys.current.includes(' ') || keys.current.includes('Shift'));
      for (const event of current.events.splice(0)) { renderer.current?.event(event, current); sound.current?.event(event.type); }
      if (canvas.current) renderer.current?.render(canvas.current, current, art.current, current.phase === 'paused' ? 0 : dt, now / 1000, aiming);
      uiClock += dt;
      if (uiClock >= .08) { uiClock = 0; force(); }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [force, aiming]);

  const loadFiles = (files: FileList | File[]) => {
    const images = Array.from(files).filter(file => /^image\//.test(file.type));
    if (!images.length) { setNotice('이미지 파일을 선택해 주세요.'); return; }
    clearInput(); game.current.phase = 'ready'; art.current = null;
    objectUrls.current.forEach(url => URL.revokeObjectURL(url)); objectUrls.current = [];
    const nextAssets = images.map(file => { const url = URL.createObjectURL(file); objectUrls.current.push(url); return { url, name: file.name }; });
    setTotal(0); setStage(0); setAssets(nextAssets); setNotice(`${images.length}개 이미지가 준비되었습니다.`); setHelp(false);
  };
  const chooseStage = (index: number) => { setStage(index); setTotal(0); setRevision(v => v + 1); setHelp(false); };
  const toggleSound = () => { sound.current?.unlock(); if (sound.current) sound.current.enabled = muted; setMuted(!muted); };
  const drawing = !!g.trail.length;
  const stateText = g.phase === 'paused' ? 'PAUSE' : g.phase === 'clear' ? 'STAGE CLEAR!!' : g.chance > 0 ? `CHANCE! ${g.chance.toFixed(1)}` : drawing ? '囲んで戻れ！  선을 닫으세요' : g.armed ? 'DRAW ON' : '敵のいないエリアを囲め！';

  return <main className="phosphor" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); loadFiles(event.dataTransfer.files); }}>
    <header className="marquee"><h1>フォスファー<span>PHOSPHOR</span></h1><p>画像陣取りアクション<span>LAKOMICS ARCADE</span></p><b>FREE PLAY</b></header>
    <section className="cabinet" aria-label="Phosphor 아케이드 게임">
      <div className="cabinet-top"><span className="score"><small>1UP</small><b>{String(total + g.score).padStart(7, '0')}</b></span><span className="round"><small>ROUND</small><b>{String(stage + 1).padStart(2, '0')}</b></span><span className="time"><small>TIME</small><b className={g.time < 30 ? 'low-time' : ''}>{String(Math.ceil(g.time)).padStart(3, '0')}</b></span><span className="lives" aria-label={`${g.lives} lives`}><small>PLAYER</small><b>{'♥'.repeat(g.lives)}<i>{'♡'.repeat(3-g.lives)}</i></b></span></div>
      <div className="machine-body">
        <div className="screen-column">
          <div className="screen-well">
            <div className={`playfield ${aspect > 1.9 ? 'wide' : ''} ${g.phase === 'clear' ? 'cleared' : ''}`} style={{ aspectRatio: aspect, '--aspect': aspect } as CSSProperties}>
              <canvas ref={canvas} tabIndex={0} aria-label="게임 화면. 방향키 이동, Space와 방향키로 선 긋기, P 일시정지." onClick={event=>{
                if (!aiming || !art.current) return;
                const bounds = event.currentTarget.getBoundingClientRect();
                const scale = Math.min(bounds.width / art.current.naturalWidth, bounds.height / art.current.naturalHeight);
                const iw = art.current.naturalWidth * scale, ih = art.current.naturalHeight * scale;
                const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
                if (x < (bounds.width-iw)/2 || x > (bounds.width+iw)/2 || y < (bounds.height-ih)/2 || y > (bounds.height+ih)/2) return;
                g.setFocus(x / bounds.width * g.cols - .5, y / bounds.height * g.rows - .5); force();
              }} />
              {g.phase === 'ready' && !aiming && <div className="screen-overlay attract">
                <span className="tag">エリアを取って、画像をオープン！</span><h2>フォスファー</h2><strong className="attract-english">PHOSPHOR</strong>
                <p>원하는 곳을 둘러싸서 공개하세요</p>
                <button className="arcade-button primary" onClick={start} disabled={!loaded || !!error}>{error ? 'IMAGE ERROR' : !loaded ? 'LOADING…' : '▶ GAME START'}</button>
                <button className="text-button" disabled={!loaded || !!error} onClick={()=>{setAiming(true);canvas.current?.focus({preventScroll:true});}}>◎ 보고 싶은 위치 선택</button>
                <span className="insert-credit">{error || 'PRESS ENTER BUTTON'}</span>
                {error && <button className="text-button" onClick={next}>다음 이미지 →</button>}
              </div>}
              {aiming && <div className="aim-banner"><span>이미지를 클릭하거나 방향키로 ◎ 이동</span><button className="arcade-button primary" onClick={start}>▶ START</button></div>}
              {g.phase === 'paused' && <div className="screen-overlay"><span className="tag">ひとやすみ</span><h2>PAUSE</h2><button className="arcade-button primary" onClick={() => { pause(); canvas.current?.focus({ preventScroll: true }); }}>▶ CONTINUE</button><button className="text-button" onClick={exit}>선택 화면으로</button></div>}
              {g.phase === 'over' && <div className="screen-overlay"><span className="tag">{g.time <= 0 ? 'TIME UP!' : 'GAME OVER'}</span><h2>CONTINUE?</h2><p>공개한 {g.percent.toFixed(1)}%는 유지됩니다</p><button className="arcade-button primary" onClick={()=>{g.continue();clearInput();canvas.current?.focus({preventScroll:true});force();}}>▶ 이어하기 · SCORE ½</button><button className="text-button" onClick={restart}>처음부터 다시</button></div>}
            </div>
          </div>
          <div className={`signal-strip ${drawing ? 'drawing' : ''} ${g.chance > 0 ? 'chance' : ''}`} role="status"><span>{stateText}</span><span>{drawing ? (g.fuse >= 0 ? '!! FUSE !!' : `FUSE ${Math.max(0, g.fuseDelay - g.trailAge).toFixed(1)}`) : 'SPACE + MOVE'}</span></div>
        </div>
        <aside className="hud">
          <section className="capture-meter"><h2>OPEN</h2><div className="percentage">{g.percent.toFixed(1)}<span>%</span></div><div className="meter"><i style={{width:`${Math.min(100,g.percent/TARGET*100)}%`}} /></div><p>CLEAR <b>{TARGET}%</b></p></section>
          <section className={`focus-card ${g.focusClaimed?'complete':''}`}><h3>◎ CHANCE POINT</h3><strong>{g.focusClaimed?'GET!!':'狙って取れ！'}</strong><p>{g.focusClaimed?'5,000点 + 10초 획득':'◎를 포함한 영역을 확보하면'}</p><b>{g.chance>0?`STOP! ${g.chance.toFixed(1)}`:g.focusClaimed?'BONUS 5,000':'적 정지 3초 + 시간 10초'}</b></section>
          <section className="guardian-card"><h3>MONSTERS</h3><div><span className="mini-monster pink">◆</span><span className="mini-monster blue">◆</span></div><p>적 둘이 있는 구역은 남습니다.<br/>빈 구석부터 둘러싸세요.</p></section>
          <section className="combo"><h3>CHAIN</h3><strong>{g.combo>1?`×${(1+(g.combo-1)*.25).toFixed(2)}`:'×1.00'}</strong><small>9초 안에 다음 점유</small></section>
          {g.phase==='clear'&&<div className="result"><b>やったね！</b><strong>STAGE CLEAR</strong><span>{g.score.toLocaleString()} PTS</span></div>}
          <button className="arcade-button secondary" disabled={!['playing','paused','clear'].includes(g.phase)} onClick={g.phase==='clear'?next:pause}>{g.phase==='clear'?(stage+1<assets.length?'NEXT STAGE ▶':'PLAY AGAIN ▶'):g.phase==='paused'?'▶ RESUME':'Ⅱ PAUSE'}</button>
        </aside>
      </div>
      <div className="control-deck"><div className="control-hint"><b>遊び方</b><span><kbd>↑↓←→</kbd> 이동</span><span><kbd>SPACE</kbd> 선 긋기</span><span><kbd>X</kbd> 그리기 전환</span></div><div className="utility-buttons"><button onClick={restart}>RESTART</button><button onClick={toggleSound}>{muted?'SOUND OFF':'SOUND ON'}</button><button aria-expanded={help} onClick={()=>{if(g.phase==='playing')pause();setHelp(!help);}}>GUIDE</button><button onClick={exit}>EXIT</button></div></div>
    </section>
    <div className="touch-controls" aria-label="화면 게임 조작"><div className="direction-pad">{pad.map(([direction,label])=><button key={direction} aria-label={`Move ${direction}`} className={direction} onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);touchDirection.current=direction;g.queueMove(direction);force();}} onPointerUp={()=>{touchDirection.current=undefined;}} onPointerCancel={()=>{touchDirection.current=undefined;}}>{label}</button>)}</div><button className={`draw-pad ${g.armed||drawing?'armed':''}`} aria-pressed={g.armed||drawing} onClick={()=>{g.arm();sound.current?.unlock();force();}}>DRAW<span>{g.armed||drawing?'ON':'X / TAP'}</span></button></div>
    {help&&<section className="help-panel"><h3>HOW TO PLAY</h3><p>방향키로 안전한 땅을 이동하고, Space + 방향키로 선을 시작합니다. X 또는 DRAW로 그리기를 켤 수도 있습니다. 안전한 땅으로 돌아오면 적이 없는 구역이 공개됩니다. 두 적을 서로 다른 쪽에 남기면 양쪽이 유지되므로, L자·U자로 빈 구석을 만들거나 적들이 한쪽에 모일 때를 노리세요.</p><p>◎ 위치는 시작 전에 직접 정할 수 있습니다. 확보하면 적과 불꽃이 3초 멈추고 10초·5,000점을 얻습니다. 긴 선에는 불꽃이 따라오며, 공개한 땅에서도 테두리 스파크는 피해야 합니다. 실패 후 이어하기는 점수를 절반 지불하고 공개한 이미지를 유지합니다. 클리어하면 전체 이미지를 감상할 수 있습니다.</p><button className="text-button" onClick={()=>setHelp(false)}>닫기 ×</button></section>}
    <section className="stage-select" aria-label="이미지 선택"><div className="stage-select-title"><h2>SELECT PICTURE</h2><p>이미지를 끌어 놓거나 선택하세요</p></div><div className="stage-thumbnails">{assets.map((asset,index)=><button key={`${asset.url}-${index}`} className={`stage-thumb ${index===stage?'selected':''}`} aria-label={`Stage ${index+1}: ${asset.name}`} aria-pressed={index===stage} onClick={()=>chooseStage(index)}><img src={asset.url} alt=""/><span>{String(index+1).padStart(2,'0')}</span></button>)}</div><label className="file-select"><span>＋ IMAGES</span><input aria-label="Select images" type="file" accept="image/*" multiple onChange={event=>{if(event.target.files)loadFiles(event.target.files);event.target.value='';}}/></label></section>
    {notice&&<p className="notice" role="status">{notice}</p>}
    <footer><span>PHOSPHOR / LAKOMICS</span><span>LOCAL FILES · NO UPLOAD</span><span>FREE PLAY</span></footer>
  </main>;
}