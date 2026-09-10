(() => {
  "use strict";
  function createModel(entries, layout, pinnedIds = [], hiddenIds = [], order = {}) {
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const trail = [], cache = new Map();
    let selectedId = null;
    let savedOrder = {...order};
    const excluded = new Set([...pinnedIds, ...hiddenIds]);
    const groups = new Map();
    for (const entry of entries) {
      if (excluded.has(entry.id) || entry.id === entry.parentId) continue;
      const group = groups.get(entry.parentId) || [];
      group.push(entry); groups.set(entry.parentId, group);
    }
    function children(parent = trail.at(-1) ?? null) {
      if (cache.has(parent)) return cache.get(parent);
      let items;
      if (parent === null) {
        const first = LakomicsRadial.getPinnedLevel(entries, layout, pinnedIds, 0);
        items = first.slots.filter(Boolean);
        for (let page = 1; page < first.pageCount; page++) {
          items.push(...LakomicsRadial.getPinnedLevel(entries, layout, pinnedIds, page).slots.filter(Boolean));
        }
      } else {
        // Radial placement can move descendants into a two-ring shortcut menu.
        // A folder window follows the real tree; use placement only for sibling order.
        const siblings = new Map((groups.get(parent) || []).map(entry => [entry.id, entry]));
        items = [];
        for (const id of layout?.parents?.[parent]?.flat() || []) {
          if (siblings.has(id)) { items.push(siblings.get(id)); siblings.delete(id); }
        }
        items.push(...siblings.values());
      }
      const unique = [...new Map(items.filter(entry => entry.id !== parent).map(entry => [entry.id, entry])).values()];
      const rank = new Map((savedOrder[parent ?? '__root__'] || []).map((id, index) => [id, index]));
      unique.sort((a,b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
      cache.set(parent, unique);
      return unique;
    }
    return {
      trail, children,
      get order() { return {...savedOrder}; },
      restoreOrder(value) { savedOrder = {...value}; cache.clear(); },
      move(id, index) {
        const items = children(), from = items.findIndex(entry => entry.id === id);
        if (from < 0 || !Number.isInteger(index) || index < 0 || index >= items.length || from === index) return false;
        const ids = items.map(entry => entry.id);
        ids.splice(index, 0, ids.splice(from, 1)[0]);
        savedOrder = {...savedOrder, [trail.at(-1) ?? '__root__']: ids};
        cache.clear(); return true;
      },
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

  function mount({ entries, layout, pinnedIds, hiddenIds, order, origin, onSave, onClose, container, onReorder, onTemporary }) {
    const model = createModel(entries, layout, pinnedIds, hiddenIds, order);
    const host = document.createElement('div'); host.id = 'lakomics-list-collector';
    const editing = Boolean(onReorder);
    if (container) host.className = 'embedded';
    const shadow = host.attachShadow({mode:'open'});
    const style = document.createElement('style'); style.textContent = CSS; shadow.append(style);
    const backdrop = document.createElement('div'); backdrop.className = 'backdrop';
    const panel = document.createElement('section'); panel.className = 'panel';
    panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','분류 선택');
    panel.innerHTML = '<header><button class="back" aria-label="이전 폴더">‹</button><div class="path"></div><button class="save-current" aria-label="현재 분류에 저장">↤</button><button class="close" aria-label="닫기">×</button></header><div class="swipe"><span class="back-reveal" aria-hidden="true">‹</span><div class="rows"></div></div><div class="notice" role="status" hidden></div>';
    backdrop.append(panel); shadow.append(backdrop); (container || document.documentElement).append(host);
    const $ = selector => panel.querySelector(selector), rows = $('.rows'), swipe = $('.swipe');
    let busy = false, disposed = false, gesture = null, suppressClick = false;
    panel.classList.toggle('editing',editing);
    if (editing) { panel.setAttribute('aria-label','목록 순서 편집'); $('.save-current').hidden = true; $('.close').hidden = true; }
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
      disposed = true; cancelReorder(); for (const animation of animations) animation.cancel(); animations.clear(); host.remove(); window.removeEventListener('resize',position);
      if (previousFocus?.isConnected) previousFocus.focus?.({preventScroll:true});
    }
    function cancel() { if (!busy) { close(); onClose(); } }
    function position() {
      if (container) return;
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
            {opacity:.4}, {opacity:1}
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
      const depth = model.trail.length;
      panel.dataset.depth = String(depth);
      panel.style.setProperty('--paper', `hsl(48 25% ${83 - Math.min(depth, 6) * 3}%)`);
      panel.style.setProperty('--row-alt', `hsl(48 22% ${78 - Math.min(depth, 6) * 3}%)`);
      $('.path').textContent = model.names().join(' > ');
      $('.path').title = $('.path').textContent;
      if (editing) $('.path').textContent ||= '전체 분류';
      const scroll = offsets.get(model.trail.join('/')) || 0;
      rows.replaceChildren(); rows.style.transform = ''; $('.back-reveal').style.opacity = 0;
      for (const entry of model.children()) {
        const wrap = document.createElement('div'); wrap.className = 'row-wrap';
        const reveal = document.createElement('span'); reveal.className = 'reveal'; reveal.textContent = '저장'; reveal.setAttribute('aria-hidden','true');
        const button = document.createElement('button'); button.className = 'row'; button.dataset.classificationId = entry.id;
        button.setAttribute('aria-keyshortcuts',editing ? 'Alt+ArrowUp Alt+ArrowDown' : 'Control+Enter');
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
      if (!model.trail.length) {
        const temporary = document.createElement('button'); temporary.className = 'temporary-save';
        temporary.textContent = '임시 저장'; temporary.disabled = editing || busy || !onTemporary;
        temporary.title = '갤탭의 임시보관 폴더에 이미지 저장';
        temporary.onclick = () => {
          if (busy || !onTemporary) return;
          try {
            if (onTemporary() === false) throw new Error('Unavailable');
            close(); onClose();
          } catch { $('.notice').textContent = '임시 저장을 열지 못했습니다. Lakomics 앱을 확인해 주세요.'; $('.notice').hidden = false; }
        };
        rows.append(temporary);
      }
      rows.scrollTop = scroll;
      $('.back').disabled = busy || !model.trail.length;
      $('.save-current').disabled = editing || busy || !model.selectedId;
      $('.save-current').setAttribute('aria-label',`${model.names().at(-1) || '현재 분류'}에 저장`);
      $('.close').disabled = busy;
    }
    $('.back').onclick = back; $('.save-current').onclick = () => void save(model.selectedId); $('.close').onclick = cancel;
    backdrop.addEventListener('click',event => { if (event.target === backdrop) cancel(); });
    rows.addEventListener('keydown',event => {
      const buttons = [...rows.querySelectorAll('.row')], index = buttons.indexOf(event.target);
      if (!event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) { event.preventDefault(); buttons[Math.max(0,Math.min(buttons.length-1,index+(event.key === 'ArrowDown'?1:-1)))]?.focus(); }
      if (event.key === 'Backspace') { event.preventDefault(); back(); }
      if (editing && event.altKey && ['ArrowUp','ArrowDown'].includes(event.key) && index >= 0) {
        event.preventDefault(); void reorder(event.target.dataset.classificationId, index + (event.key === 'ArrowUp' ? -1 : 1)); return;
      }
      if (!editing && event.key === 'Enter' && event.ctrlKey && index >= 0) { event.preventDefault(); void save(event.target.dataset.classificationId,event.target); }
    });
    swipe.addEventListener('pointerdown',event => {
      if (editing) return;
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
      if (container || event.key !== 'Tab') return;
      const buttons = [...panel.querySelectorAll('button:not(:disabled)')], first = buttons[0], last = buttons.at(-1);
      if (!first) event.preventDefault();
      else if (event.shiftKey && shadow.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && shadow.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    let reorderGesture = null, scrollFrame = null;
    function cancelReorder() {
      const drag = reorderGesture; reorderGesture = null;
      if (drag) { clearTimeout(drag.timer); drag.row.style.transform = ''; drag.row.classList.remove('lifted');
        if (swipe.hasPointerCapture(drag.id)) swipe.releasePointerCapture(drag.id); }
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame); scrollFrame = null;
      rows.querySelectorAll('.drop-before,.drop-after').forEach(row => row.classList.remove('drop-before','drop-after'));
    }
    async function reorder(id, target) {
      if (busy || disposed) return;
      const previous = model.order;
      if (!model.move(id,target)) return;
      remember(); busy = true; render();
      panel.setAttribute('aria-busy','true');
      for (const button of panel.querySelectorAll('button')) button.disabled = true;
      $('.notice').hidden = false; $('.notice').textContent = '순서 저장 중…';
      try {
        const result = await onReorder(model.order);
        if (!result?.ok) throw new Error('Not saved');
        if (!disposed) $('.notice').textContent = '순서 저장됨';
      } catch {
        model.restoreOrder(previous);
        if (!disposed) $('.notice').textContent = '저장하지 못해 원래 순서로 되돌렸습니다.';
      } finally {
        busy = false;
        if (!disposed) { panel.removeAttribute('aria-busy'); render();
          [...rows.querySelectorAll('.row')].find(row => row.dataset.classificationId === id)?.focus({preventScroll:true}); }
      }
    }
    function updateDrop() {
      const drag = reorderGesture; if (!drag?.lifted) return;
      drag.row.style.transform = `translateY(${drag.y-drag.startY+rows.scrollTop-drag.scroll}px)`;
      const others = [...rows.querySelectorAll('.row')].filter(row => row !== drag.row);
      drag.target = others.filter(row => { const box = row.parentElement.getBoundingClientRect(); return drag.y > box.top+box.height/2; }).length;
      rows.querySelectorAll('.drop-before,.drop-after').forEach(row => row.classList.remove('drop-before','drop-after'));
      const target = others[drag.target];
      if (target) target.parentElement.classList.add('drop-before');
      else others.at(-1)?.parentElement.classList.add('drop-after');
    }
    function autoScroll() {
      const drag = reorderGesture; if (!drag?.lifted) return;
      const box = rows.getBoundingClientRect();
      const speed = drag.y < box.top+36 ? -Math.min(9,(box.top+36-drag.y)/4) : drag.y > box.bottom-36 ? Math.min(9,(drag.y-box.bottom+36)/4) : 0;
      if (speed) { rows.scrollTop += speed; updateDrop(); }
      scrollFrame = requestAnimationFrame(autoScroll);
    }
    if (editing) {
      swipe.addEventListener('pointerdown',event => {
        if (busy || event.button !== 0 || reorderGesture) return;
        const row = event.target.closest('.row'); if (!row) return;
        suppressClick = false;
        const drag = reorderGesture = {id:event.pointerId,row,startX:event.clientX,startY:event.clientY,y:event.clientY,scroll:rows.scrollTop,lifted:false,moved:false,target:0};
        swipe.setPointerCapture(event.pointerId);
        drag.timer = setTimeout(() => {
          if (reorderGesture !== drag || drag.moved) return;
          drag.lifted = true; suppressClick = true; row.classList.add('lifted');
          row.focus({preventScroll:true}); updateDrop(); autoScroll();
        },400);
      });
      swipe.addEventListener('pointermove',event => {
        const drag = reorderGesture; if (!drag || drag.id !== event.pointerId) return;
        if (!drag.lifted && Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>10) {
          drag.moved = true; suppressClick = true; clearTimeout(drag.timer);
        }
        if (drag.moved && !drag.lifted) rows.scrollTop += drag.y-event.clientY;
        drag.y = event.clientY;
        if (drag.lifted) { event.preventDefault(); updateDrop(); }
      });
      swipe.addEventListener('pointerup',event => {
        const drag = reorderGesture; if (!drag || drag.id !== event.pointerId) return;
        const id = drag.row.dataset.classificationId, target = drag.target;
        cancelReorder();
        if (drag.lifted) void reorder(id,target);
        else if (!drag.moved) { suppressClick = true; drag.row.onclick(); }
      });
      swipe.addEventListener('pointercancel',cancelReorder);
      swipe.addEventListener('lostpointercapture',event => { if (event.target === swipe) cancelReorder(); });
      panel.addEventListener('keydown',event => { if (event.key === 'Escape' && reorderGesture) { event.preventDefault(); suppressClick = true; cancelReorder(); } });
    }
    window.addEventListener('resize',position); render(); position(); if (!container) rows.querySelector('.row')?.focus({preventScroll:true});
    return {close,host,model};
  }
  const CSS = `
:host{--paper:#d7d3b9;--ink:#302f28;--line:#aaa68f;--quiet:#bdb9a1;font:14px/1.4 'Segoe UI',sans-serif;color:var(--ink);position:fixed;inset:0;z-index:2147483646;pointer-events:none}
*{box-sizing:border-box}button{font:inherit;color:inherit;cursor:pointer;border:0;border-radius:0}button:focus-visible{outline:2px solid var(--ink);outline-offset:-3px}button:disabled{opacity:.35;cursor:default}
.backdrop{position:fixed;inset:0;pointer-events:auto}.panel{position:fixed;width:350px;height:480px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 16px);background:var(--paper);box-shadow:0 14px 40px #0005;display:flex;flex-direction:column;border:1px solid var(--line)}
.panel:before{content:'';position:absolute;inset:8px auto 8px 7px;border-left:4px solid var(--quiet);width:3px;border-right:1px solid var(--line);pointer-events:none}
header{display:flex;align-items:center;gap:3px;min-height:52px;margin:0 10px 0 21px;border-bottom:1px solid var(--line)}header button{flex:none;width:30px;min-height:40px;background:none;font-size:22px}.save-current{font-size:19px}.path{flex:1;min-width:0;max-height:60px;overflow:auto;font-size:12px;overflow-wrap:anywhere}
.swipe{flex:1;min-height:0;position:relative;margin:8px 10px 8px 21px;touch-action:pan-y pinch-zoom;overflow:hidden}.rows{position:relative;height:100%;touch-action:pan-y pinch-zoom;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--ink) transparent;padding-right:5px;background:var(--paper)}
.row-wrap{position:relative;touch-action:pan-y pinch-zoom;overflow:hidden;margin-bottom:4px;--row-paper:var(--paper)}.row-wrap:nth-child(even){--row-paper:var(--row-alt,#c9c5ac)}.reveal{position:absolute;inset:0;display:flex;align-items:center;justify-content:flex-end;padding-right:16px;background:var(--quiet);color:var(--ink);font-size:12px}.ready .reveal{background:var(--ink);color:var(--paper)}
.row{position:relative;display:flex;align-items:center;gap:10px;width:100%;min-height:44px;padding:9px 10px;background:var(--row-paper);text-align:left;user-select:none;-webkit-user-select:none}.row:before{content:'';width:10px;height:10px;flex:none;background:var(--ink)}.name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mark{font-size:17px}.row:hover{background:var(--quiet)}.row.selected{background:var(--ink);color:var(--paper)}.row.selected:before{background:var(--paper)}.back-reveal{position:absolute;left:12px;top:40%;font-size:40px;opacity:0}.notice{font-size:12px;margin:0 12px 10px 23px;max-height:48px;overflow:auto}[hidden]{display:none!important}
.temporary-save{display:block;width:100%;min-height:44px;margin-top:12px;padding:10px 12px;border-top:1px solid #838e87;background:#a8b9ae;color:#263b32;text-align:left}.temporary-save:before{content:"↓";margin-right:12px}.temporary-save:hover{background:#97ad9f}.temporary-save:disabled{opacity:.65}
.reveal{transition:background-color 100ms,color 100ms}.ready .reveal{font-weight:600}.saving .reveal{background:var(--ink);color:var(--paper);justify-content:center;font-size:20px;letter-spacing:4px;padding:0}.saved .reveal{letter-spacing:0;font-size:25px}.panel[aria-busy=true] .row:disabled{opacity:1}.panel[aria-busy=true] .row-wrap:not(.saving){opacity:.6}
:host(.embedded){position:relative;display:block;inset:auto;z-index:auto;pointer-events:auto;width:100%;max-width:350px;min-width:0}
:host(.embedded) .backdrop{position:relative;inset:auto}:host(.embedded) .panel{position:relative;width:100%;max-width:100%;height:480px;box-shadow:none}
.editing .swipe,.editing .rows,.editing .row-wrap,.editing .row{touch-action:none}
.editing .row-wrap{overflow:visible}.editing .row-wrap:has(.lifted){z-index:2}
.editing .lifted{box-shadow:0 5px 14px #0005;outline:2px solid var(--ink);background:var(--quiet);cursor:grabbing}
.editing .drop-before{box-shadow:0 -3px var(--ink)}.editing .drop-after{box-shadow:0 3px var(--ink)}
@media(prefers-reduced-motion:reduce){.row{transition:none!important}}
`;
  globalThis.LakomicsListCollector = {createModel,mount};
})();
