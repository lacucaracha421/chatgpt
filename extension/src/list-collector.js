(() => {
  "use strict";
  function createModel(entries, layout, pinnedIds = [], hiddenIds = []) {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const trail = [], cache = new Map();
    let selectedId = null;
    function children(parent = trail.at(-1) ?? null) {
      if (cache.has(parent)) return cache.get(parent);
      const level = page => parent === null
        ? LakomicsRadial.getPinnedLevel(entries, layout, pinnedIds, page)
        : LakomicsRadial.getCompactLevel(entries, layout, parent, page, [...pinnedIds, ...hiddenIds]);
      const first = level(0), items = first.slots.filter(Boolean);
      for (let page = 1; page < first.pageCount; page++) items.push(...level(page).slots.filter(Boolean));
      const unique = [...new Map(items.filter(entry => entry.id !== parent).map(entry => [entry.id, entry])).values()];
      cache.set(parent, unique);
      return unique;
    }
    return {
      trail, children,
      get selectedId() { return selectedId; },
      names() {
        const path = [...trail];
        if (selectedId && selectedId !== path.at(-1)) path.push(selectedId);
        const visited = new Set(path);
        let parent = byId.get(path[0])?.parentId;
        while (parent && byId.has(parent) && !visited.has(parent)) {
          path.unshift(parent); visited.add(parent); parent = byId.get(parent).parentId;
        }
        return path.map(id => byId.get(id)?.name ?? "");
      },
      activate(id) {
        if (!children().some(entry => entry.id === id)) return;
        selectedId = id;
        if (children(id).length && !trail.includes(id)) trail.push(id);
      },
      back() { trail.pop(); selectedId = trail.at(-1) ?? null; },
      canSave(id) { return Boolean(id) && (id === selectedId || children().some(entry => entry.id === id)); },
    };
  }

  function mount({ entries, layout, pinnedIds, hiddenIds, origin, onSave, onClose }) {
    const model = createModel(entries, layout, pinnedIds, hiddenIds);
    const host = document.createElement('div'); host.id = 'lakomics-list-collector';
    const shadow = host.attachShadow({mode:'open'});
    const style = document.createElement('style'); style.textContent = CSS; shadow.append(style);
    const backdrop = document.createElement('div'); backdrop.className = 'backdrop';
    const panel = document.createElement('section'); panel.className = 'panel';
    panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','분류 선택');
    panel.innerHTML = '<header><button class="back" aria-label="이전 폴더">‹</button><div class="path"></div><button class="save-current" aria-label="현재 분류에 저장">↤</button><button class="close" aria-label="닫기">×</button></header><div class="swipe"><span class="back-reveal" aria-hidden="true">‹</span><div class="rows"></div></div><div class="notice" role="status" hidden></div>';
    backdrop.append(panel); shadow.append(backdrop); document.documentElement.append(host);
    const $ = selector => panel.querySelector(selector), rows = $('.rows'), swipe = $('.swipe');
    let busy = false, disposed = false, gesture = null, suppressClick = false;
    const offsets = new Map(), previousFocus = document.activeElement;
    const animations = new Set();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function animate(element, frames, duration, easing = 'cubic-bezier(.2,.8,.2,1)') {
      const animation = element.animate(frames, {duration: reducedMotion ? 0 : duration, easing, fill:'forwards'});
      animations.add(animation);
      return animation.finished.catch(() => {});
    }
    const remember = () => offsets.set(model.trail.join('/'), rows.scrollTop);
    function close() {
      if (disposed) return;
      disposed = true; for (const animation of animations) animation.cancel(); animations.clear(); host.remove(); window.removeEventListener('resize',position);
      if (previousFocus?.isConnected) previousFocus.focus?.({preventScroll:true});
    }
    function cancel() { if (!busy) { close(); onClose(); } }
    function position() {
      panel.style.left = `${Math.max(8,Math.min(window.innerWidth-panel.offsetWidth-8,origin.x+16))}px`;
      panel.style.top = `${Math.max(8,Math.min(window.innerHeight-panel.offsetHeight-8,origin.y-80))}px`;
    }
    function back() { if (busy || !model.trail.length) return; remember(); model.back(); render(); rows.querySelector('.row')?.focus({preventScroll:true}); }
    async function save(id, row) {
      if (busy || !model.canSave(id)) return;
      remember();
      busy = true; panel.setAttribute('aria-busy','true');
      for (const button of panel.querySelectorAll('button')) button.disabled = true;
      const wrap = row?.parentElement, reveal = wrap?.querySelector('.reveal');
      wrap?.classList.add('saving');
      if (reveal) reveal.textContent = '···';
      const departure = row ? animate(row, [
        {transform:getComputedStyle(row).transform}, {transform:'translateX(-105%)'}
      ], 170, 'cubic-bezier(.4,0,.8,.4)') : Promise.resolve();
      $('.notice').hidden = true;
      try {
        const [result] = await Promise.all([onSave(id), departure]);
        if (disposed) return;
        if (result.ok) {
          wrap?.classList.add('saved');
          if (reveal) reveal.textContent = '✓';
          else $('.save-current').textContent = '✓';
          panel.setAttribute('aria-label','저장 완료');
          await animate(reveal || $('.save-current'), [
            {opacity:.4,transform:'scale(.82)'}, {opacity:1,transform:'scale(1)'}
          ], 150);
          if (disposed) return;
          await animate(panel, [
            {opacity:1,transform:'scale(1)'}, {opacity:0,transform:'scale(.96) translateY(3px)'}
          ], 140, 'cubic-bezier(.4,0,1,1)');
          if (disposed) return;
          close(); onClose(result); return;
        }
        $('.notice').textContent = result.message || '저장 실패'; $('.notice').hidden = false;
      } catch { if (!disposed) { $('.notice').textContent = '연결 실패'; $('.notice').hidden = false; } }
      finally {
        if (!disposed) {
          await departure;
          if (row) await animate(row, [{transform:'translateX(-105%)'},{transform:'translateX(0)'}], 180);
          for (const animation of animations) animation.cancel(); animations.clear();
          busy = false;
          if (!disposed) { panel.removeAttribute('aria-busy'); render(); }
        }
      }
    }
    function render() {
      $('.path').textContent = model.names().join(' > ');
      $('.path').title = $('.path').textContent;
      const scroll = offsets.get(model.trail.join('/')) || 0;
      rows.replaceChildren(); rows.style.transform = ''; $('.back-reveal').style.opacity = 0;
      for (const entry of model.children()) {
        const wrap = document.createElement('div'); wrap.className = 'row-wrap';
        const reveal = document.createElement('span'); reveal.className = 'reveal'; reveal.textContent = '저장'; reveal.setAttribute('aria-hidden','true');
        const button = document.createElement('button'); button.className = 'row'; button.dataset.classificationId = entry.id;
        button.setAttribute('aria-keyshortcuts','Control+Enter');
        const folder = model.children(entry.id).length > 0;
        const name = document.createElement('span'); name.className = 'name'; name.textContent = entry.name;
        const mark = document.createElement('span'); mark.className = 'mark'; mark.textContent = folder ? '›' : ''; mark.setAttribute('aria-hidden','true');
        button.classList.toggle('selected',model.selectedId === entry.id);
        button.append(name,mark); button.title = entry.name;
        button.onclick = () => {
          if (busy) return;
          remember(); model.activate(entry.id); $('.notice').hidden = true; render();
          (folder ? rows.querySelector('.row') : [...rows.querySelectorAll('.row')].find(row => row.dataset.classificationId === entry.id))?.focus({preventScroll:true});
        };
        wrap.append(reveal,button); rows.append(wrap);
      }
      rows.scrollTop = scroll;
      $('.back').disabled = busy || !model.trail.length;
      $('.save-current').disabled = busy || !model.selectedId;
      $('.save-current').setAttribute('aria-label',`${model.names().at(-1) || '현재 분류'}에 저장`);
      $('.close').disabled = busy;
    }
    $('.back').onclick = back; $('.save-current').onclick = () => void save(model.selectedId); $('.close').onclick = cancel;
    backdrop.addEventListener('click',event => { if (event.target === backdrop) cancel(); });
    rows.addEventListener('keydown',event => {
      const buttons = [...rows.querySelectorAll('.row')], index = buttons.indexOf(event.target);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); buttons[Math.max(0,Math.min(buttons.length-1,index+(event.key === 'ArrowDown'?1:-1)))]?.focus(); }
      if (event.key === 'Backspace') { event.preventDefault(); back(); }
      if (event.key === 'Enter' && event.ctrlKey && index >= 0) { event.preventDefault(); void save(event.target.dataset.classificationId,event.target); }
    });
    swipe.addEventListener('pointerdown',event => {
      if (busy || event.button !== 0 || gesture) return;
      const row = event.target.closest('.row');
      gesture = {id:event.pointerId,x:event.clientX,y:event.clientY,dx:0,axis:null,row}; suppressClick = false;
    });
    swipe.addEventListener('pointermove',event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const dx = event.clientX-gesture.x, dy = event.clientY-gesture.y;
      if (!gesture.axis && Math.hypot(dx,dy)>12) {
        gesture.axis = Math.abs(dx)>Math.abs(dy)*1.3?'x':'y';
        if (gesture.axis === 'x') { swipe.setPointerCapture(event.pointerId); suppressClick = true; }
      }
      if (gesture.axis !== 'x') return;
      event.preventDefault(); gesture.dx = dx;
      rows.style.transform = `translateX(${model.trail.length ? Math.max(0,Math.min(dx,swipe.clientWidth)) : 0}px)`;
      $('.back-reveal').style.opacity = dx>0 && model.trail.length ? Math.min(1,dx/threshold()) : 0;
      if (gesture.row) {
        const travel = dx < -threshold() ? -threshold() + (dx + threshold()) * .35 : Math.min(0,dx);
        gesture.row.style.transition = 'none'; gesture.row.style.transform = `translateX(${Math.max(travel,-swipe.clientWidth)}px)`;
        gesture.row.parentElement.classList.toggle('ready',dx <= -threshold());
      }
    });
    function threshold() { return Math.min(100,swipe.clientWidth*.32); }
    function finish(event,cancelled=false) {
      if (!gesture || gesture.id !== event.pointerId) return;
      const done = gesture; gesture = null;
      rows.style.transform = ''; $('.back-reveal').style.opacity = 0;
      if (!cancelled && done.axis === 'x' && done.dx <= -threshold() && done.row) {
        void save(done.row.dataset.classificationId,done.row); return;
      }
      if (done.row) { done.row.style.transition = 'transform 140ms ease-out'; done.row.style.transform = ''; done.row.parentElement.classList.remove('ready'); }
      if (!cancelled && done.axis === 'x' && done.dx >= threshold()) back();
    }
    swipe.addEventListener('pointerup',event => finish(event));
    swipe.addEventListener('pointercancel',event => finish(event,true));
    // Touch starts with implicit row capture; transferring it to swipe is not cancellation.
    swipe.addEventListener('lostpointercapture',event => { if (event.target === swipe) finish(event,true); });
    swipe.addEventListener('click',event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; } },true);
    panel.addEventListener('keydown',event => {
      if (event.key !== 'Tab') return;
      const buttons = [...panel.querySelectorAll('button:not(:disabled)')], first = buttons[0], last = buttons.at(-1);
      if (!first) event.preventDefault();
      else if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    window.addEventListener('resize',position); render(); position(); rows.querySelector('.row')?.focus({preventScroll:true});
    return {close,host,model};
  }
  const CSS = `
:host{--paper:#d7d3b9;--ink:#4b493e;--line:#aaa68f;--quiet:#bdb9a1;font:14px/1.4 'Segoe UI',sans-serif;color:var(--ink);position:fixed;inset:0;z-index:2147483646;pointer-events:none}
*{box-sizing:border-box}button{font:inherit;color:inherit;cursor:pointer;border:0;border-radius:0}button:focus-visible{outline:2px solid var(--ink);outline-offset:-3px}button:disabled{opacity:.35;cursor:default}
.backdrop{position:fixed;inset:0;pointer-events:auto}.panel{position:fixed;width:350px;height:410px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);background:var(--paper);box-shadow:0 14px 40px #0005;display:flex;flex-direction:column;border:1px solid var(--line)}
.panel:before{content:'';position:absolute;inset:8px auto 8px 7px;border-left:4px solid var(--quiet);width:3px;border-right:1px solid var(--line);pointer-events:none}
header{display:flex;align-items:center;gap:3px;min-height:52px;margin:0 10px 0 21px;border-bottom:1px solid var(--line)}header button{flex:none;width:30px;min-height:40px;background:none;font-size:22px}.save-current{font-size:19px}.path{flex:1;min-width:0;max-height:60px;overflow:auto;font-size:12px;overflow-wrap:anywhere}
.swipe{flex:1;min-height:0;position:relative;margin:8px 10px 8px 21px;touch-action:pan-y pinch-zoom;overflow:hidden}.rows{position:relative;height:100%;touch-action:pan-y pinch-zoom;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ink) transparent;padding-right:5px;background:var(--paper)}
.row-wrap{position:relative;touch-action:pan-y pinch-zoom;overflow:hidden;margin-bottom:4px;--row-paper:var(--paper)}.row-wrap:nth-child(even){--row-paper:#c9c5ac}.reveal{position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;padding-right:16px;background:var(--quiet);color:var(--ink);font-size:12px}.ready .reveal{background:var(--ink);color:var(--paper)}
.row{position:relative;display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:9px 10px;background:var(--row-paper);text-align:left;user-select:none;-webkit-user-select:none}.row:before{content:'';width:10px;height:10px;flex:none;background:var(--ink)}.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mark{font-size:17px}.row:hover{background:var(--quiet)}.row.selected{background:var(--ink);color:var(--paper)}.row.selected:before{background:var(--paper)}.back-reveal{position:absolute;left:12px;top:40%;font-size:40px;opacity:0}.notice{font-size:12px;margin:0 12px 10px 23px;max-height:48px;overflow:auto}[hidden]{display:none!important}
.reveal{transition:background-color 100ms,color 100ms}.ready .reveal{font-weight:600}.saving .reveal{background:var(--ink);color:var(--paper);justify-content:center;font-size:20px;letter-spacing:4px;padding:0}.saved .reveal{letter-spacing:0;font-size:25px}.panel[aria-busy=true] .row:disabled{opacity:1}.panel[aria-busy=true] .row-wrap:not(.saving){opacity:.6}
@media(prefers-reduced-motion:reduce){.row{transition:none!important}}
`;
  globalThis.LakomicsListCollector = {createModel,mount};
})();
