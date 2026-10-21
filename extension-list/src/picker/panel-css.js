// Style of the Arca Live picker panel. It is a string (not a web-accessible file) so the closed
// shadow root can adopt it synchronously and the panel never appears unstyled.
globalThis.LakomicsPickerCss = String.raw`
:host{all:initial;--p-bg:#fbfaf7;--p-raised:#fbfaf7;--p-field:#e9e6df;--p-line:#d5d1c8;--p-line-soft:#e3dfd7;--p-text:#1f2123;--p-muted:#5d6165;--p-faint:#8b8f93;--p-hover:#efede7;--p-press:#e5e2da;--p-accent:#2b2d2f;--p-on-accent:#fbfaf7;--p-accent-hover:#3a3c3e;--p-focus:#2f6fdb;--p-ok:#3f8a4f;--p-danger:#c2412e;--p-tile:#dedbd4;--p-scrim:rgb(18 18 19/.62);--p-shadow:-1px 0 0 rgb(40 36 30/.04),-8px 0 24px rgb(40 36 30/.10);--ui:"Pretendard Variable",Pretendard,"Malgun Gothic","Segoe UI",sans-serif;--ease:cubic-bezier(.2,0,0,1);color-scheme:light}
:host([data-theme="dark"]){--p-bg:#232425;--p-raised:#292a2b;--p-field:#2c2d2e;--p-line:#3b3c3e;--p-line-soft:#2f3031;--p-text:#e7e9ec;--p-muted:#a0a3a5;--p-faint:#7d8184;--p-hover:#2f3031;--p-press:#3c3d3e;--p-accent:#ddd8ca;--p-on-accent:#242522;--p-accent-hover:#e8e4d8;--p-focus:#7db1ff;--p-ok:#7fb88a;--p-danger:#e26767;--p-tile:#2c2d2e;--p-shadow:-8px 0 24px rgb(0 0 0/.35);color-scheme:dark}
*{box-sizing:border-box}[hidden]{display:none!important}
.lk{position:absolute;inset:0 auto 0 0;width:var(--panel-width);display:flex;flex-direction:column;background:var(--p-bg);border-left:1px solid var(--p-line);color:var(--p-text);font:400 15px/20px var(--ui);-webkit-font-smoothing:antialiased;opacity:1;transition:opacity 140ms var(--ease) 60ms}
.dock.leaving{animation:lkOut 140ms var(--ease) both}
:host{transition:width 200ms var(--ease)}
:host([data-folded="true"]){transition-delay:90ms}
.dock{position:absolute;inset:0;box-shadow:var(--p-shadow);color:var(--p-text);font:400 15px/20px var(--ui);animation:lkIn 200ms var(--ease) both}
:host([data-overlay="true"]) .dock{box-shadow:-12px 0 36px rgb(0 0 0/.32)}
.clip{position:absolute;inset:0;overflow:hidden;background:var(--p-bg)}
:host([data-folded="true"]) .lk{opacity:0;pointer-events:none;transition:opacity 90ms var(--ease)}
.rail{position:absolute;inset:0 0 0 auto;width:56px;display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 0 12px;background:var(--p-bg);border-left:1px solid var(--p-line);opacity:0;pointer-events:none;transition:opacity 90ms var(--ease)}
:host([data-folded="true"]) .rail{opacity:1;pointer-events:auto;transition:opacity 120ms var(--ease) 200ms}
.rail .sq{width:40px;height:32px}
.rail-items{display:flex;flex-direction:column;align-items:center;gap:8px;flex:1;min-height:0;overflow:hidden;width:100%}
.rail-thumb,.foot-thumb{position:relative;flex:none;width:40px;height:40px;border:0;padding:0;overflow:hidden;background:var(--p-tile)}
.rail-thumb img,.foot-thumb img{display:block;width:100%;height:100%;object-fit:cover}
.rail-thumb .num,.foot-thumb .num{top:2px;left:2px;min-width:16px;height:16px;line-height:16px;padding:0 3px;font-size:11px}
.rail-more,.rail-count{font-size:12px;color:var(--p-muted);font-variant-numeric:tabular-nums}
.rail .btn{width:40px;padding:0}
.resize{position:absolute;z-index:20;top:0;bottom:0;left:0;width:8px;cursor:col-resize;touch-action:none;outline-offset:-2px}
.resize:focus-visible{outline:2px solid var(--p-focus)}
.resize::before{content:"";position:absolute;inset:0 auto 0 0;width:2px;background:var(--p-muted);opacity:0}
.resize::after{content:"";position:absolute;top:calc(50% - 16px);left:3px;width:2px;height:32px;border-left:2px dotted var(--p-muted);opacity:0}
.resize:hover::before,.resize:hover::after,.resize:focus-visible::before,.resize:focus-visible::after,:host([data-dragging]) .resize::before,:host([data-dragging]) .resize::after{opacity:1}
:host([data-dragging]),:host([data-dragging]) .lk{transition:none!important}
.lk-sub .scope{font-size:12px}
.foot{padding-right:8px;gap:4px}.foot .cbtn{font-size:12px;padding:0 4px}.foot .btn{font-size:13px;padding:0 8px}
.tree-section{padding:8px 12px 4px;color:var(--p-muted);font-size:12px;font-weight:600}
.dock .ic,.prev .ic{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.dock button,.prev button{font:inherit;color:inherit;cursor:pointer}
.dock button:focus-visible,.prev button:focus-visible,.lk [tabindex]:focus-visible,.lk input:focus-visible{outline:2px solid var(--p-focus);outline-offset:-2px}
.lk-head{flex:none;display:flex;align-items:center;gap:4px;height:48px;padding:0 8px 0 12px}
.lk-mark{flex:none;width:14px;height:16px;color:var(--p-accent)}
.folder{flex:1;min-width:0;display:flex;align-items:center;gap:8px;height:32px;padding:0 8px 0 12px;border:0;border-radius:4px;background:var(--p-field);text-align:left}
.folder:hover{background:color-mix(in srgb,var(--p-field) 70%,var(--p-hover))}
.folder .ic{color:var(--p-muted)}
.folder .path{flex:1;min-width:0;display:flex;overflow:hidden;white-space:nowrap}
.folder .par{color:var(--p-muted);overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0}
.folder .leaf{flex:none;font-weight:600}
.folder .none{color:var(--p-muted)}
.cbtn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;flex:none;border:0;border-radius:4px;background:transparent;color:var(--p-muted)!important;white-space:nowrap}
.cbtn:hover{background:var(--p-hover);color:var(--p-text)!important}
.cbtn.sq{width:28px;padding:0;justify-content:center}
.rail .sq{width:40px}
.cbtn .kb{margin-left:4px;font-size:12px;color:var(--p-faint)}
.cbtn[disabled]{opacity:.4;cursor:default}
.lk-sub{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;min-height:36px;padding:4px 12px}
.lk-sub .scope{display:flex;align-items:center;gap:8px;padding:0;border:0;background:transparent;color:var(--p-muted)}
.lk-sub .order{display:flex;height:24px;background:var(--p-field);padding:2px;border-radius:2px;gap:2px}.order button{border:0;background:transparent;color:var(--p-muted);border-radius:2px;font:inherit;font-size:12px;padding:0 6px;cursor:pointer}.order button[aria-checked="true"]{background:var(--p-accent);color:var(--p-on-accent)}.cnt{margin-left:auto;font-size:12px;color:var(--p-faint);font-variant-numeric:tabular-nums}
.sw{position:relative;width:32px;height:18px;flex:none;border-radius:9px;background:color-mix(in srgb,var(--p-text) 22%,var(--p-field))}
.sw::before{content:"";position:absolute;left:3px;top:3px;width:12px;height:12px;border-radius:50%;background:var(--p-bg);transition:transform 120ms var(--ease)}
.sw.on{background:var(--p-accent)}.sw.on::before{background:var(--p-on-accent);transform:translateX(14px)}
.body{flex:1;min-height:0;position:relative;display:flex;flex-direction:column;border-top:1px solid var(--p-line-soft)}
.grid{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:grid;grid-template-columns:repeat(var(--columns,3),minmax(0,1fr));grid-auto-rows:max-content;gap:2px;align-content:start;align-items:start}
.grid[inert]{pointer-events:none}
.grid .row{display:contents}
.tile{position:relative;width:100%;aspect-ratio:1/1;overflow:hidden;background:var(--p-tile);outline:none;cursor:pointer;user-select:none}
.tile img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.tile.sel::after{content:"";position:absolute;inset:0;box-shadow:inset 0 0 0 2px var(--p-accent),inset 0 0 0 3px rgb(0 0 0/.28);pointer-events:none}
.tile:focus-visible::before{content:"";position:absolute;inset:0;z-index:3;box-shadow:inset 0 0 0 2px var(--p-focus);pointer-events:none}
.num{position:absolute;left:4px;top:4px;z-index:2;min-width:20px;height:20px;padding:0 6px;border-radius:2px;background:var(--p-accent);color:var(--p-on-accent);font:600 12px/20px var(--ui);text-align:center;font-variant-numeric:tabular-nums}
.num.bad{background:var(--p-danger);color:#fff}
.chk{position:absolute;left:6px;top:6px;z-index:2;width:16px;height:16px;border:1.5px solid #fff;border-radius:2px;box-shadow:0 0 0 1px rgb(0 0 0/.22),0 1px 4px rgb(0 0 0/.45);opacity:0;transition:opacity 90ms var(--ease)}
.pv{position:absolute;right:4px;bottom:4px;z-index:2;width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:2px;background:var(--p-scrim);color:#fff!important;opacity:0;transition:opacity 90ms var(--ease);padding:0}
.tile:hover .chk,.tile:focus-within .chk,.tile:focus .chk,.tile:hover .pv,.tile:focus-within .pv,.tile:focus .pv{opacity:1}
.tile.sel .chk{display:none}
.done{position:absolute;left:4px;bottom:4px;z-index:2;display:flex;align-items:center;gap:4px;height:20px;padding:0 6px;border-radius:2px;background:var(--p-scrim);color:#fff;font:600 12px/20px var(--ui)}
.done .ic{width:12px;height:12px}
.tray{flex:none;display:flex;align-items:center;gap:8px;height:0;overflow:hidden;padding:0 8px 0 16px;border-top:0 solid var(--p-line);transition:height 140ms var(--ease)}
.tray.visible{height:64px;border-top-width:1px}
.tray .strip{flex:1;min-width:0;display:flex;gap:4px;overflow:hidden}
.tray .t{position:relative;flex:none;width:48px;height:48px;background:var(--p-tile);overflow:hidden;cursor:default}
.tray .t img{width:100%;height:100%;object-fit:cover;display:block}
.tray .t .num{left:2px;top:2px;min-width:16px;height:16px;padding:0 4px;font-size:11px;line-height:16px}
.tray .t .x{position:absolute;right:2px;top:2px;width:16px;height:16px;display:grid;place-items:center;border:0;padding:0;border-radius:2px;background:var(--p-scrim);color:#fff!important;opacity:0}
.tray .t:hover .x,.tray .t:focus-within .x,.tray .t:focus .x{opacity:1}.tray .t .x .ic{width:12px;height:12px}
.foot{flex:none;display:flex;align-items:center;gap:4px;height:56px;padding:0 8px;border-top:1px solid var(--p-line)}
.foot .sp{flex:1}
.foot .busy{font-size:12px;color:var(--p-faint)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 12px;flex:none;border:1px solid var(--p-line);border-radius:4px;background:var(--p-bg);color:var(--p-text);white-space:nowrap}
.btn.primary{border-color:var(--p-accent);background:var(--p-accent);color:var(--p-on-accent)!important;font-weight:600;font-variant-numeric:tabular-nums}
.btn.primary:hover{background:var(--p-accent-hover)}
.btn[disabled]{opacity:.4;cursor:default}
.job{flex:none;max-height:calc(32px + 4 * 48px + 4px);overflow-y:auto;border-top:1px solid var(--p-line);padding:0 8px 4px 16px}
.slab{display:flex;align-items:center;gap:8px;height:32px;font-size:12px;color:var(--p-faint)}
.slab::before{content:"";width:5px;height:5px;flex:none;background:var(--p-muted)}
.slab .rule{flex:1;height:1px;background:linear-gradient(90deg,var(--p-line),transparent)}
.slab .c{font-variant-numeric:tabular-nums}
.jr{display:flex;align-items:center;gap:8px;height:48px;border-top:1px solid var(--p-line-soft)}
.jr .num{position:static;flex:none}
.jr .th{flex:none;width:40px;height:40px;background:var(--p-tile);position:relative;overflow:hidden}
.jr .th img{width:100%;height:100%;object-fit:cover;display:block}
.jr .st{flex:1;min-width:0;display:flex;align-items:center;gap:4px;white-space:nowrap}
.jr .st small{margin-left:4px;font-size:12px;color:var(--p-faint);overflow:hidden;text-overflow:ellipsis}
.jr.ok .st{color:var(--p-ok)}.jr.bad .st{color:var(--p-danger)}.jr.up .st{color:var(--p-muted)}.jr.wait .st{color:var(--p-faint)}
.note{flex:none;display:flex;align-items:center;gap:8px;min-height:40px;padding:0 8px 0 16px;border-top:1px solid var(--p-line);color:var(--p-muted)}
.note .ic{color:var(--p-danger)}
.note span{flex:1}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:32px;text-align:center}
.empty .big{width:32px;height:32px;color:var(--p-faint);stroke-width:1.25}
.empty b{font-weight:600}
.empty small{font-size:12px;color:var(--p-faint);max-width:240px}
.empty .btn{margin-top:8px}
.skel{flex:1;display:grid;grid-template-columns:repeat(var(--columns,3),minmax(0,1fr));grid-auto-rows:max-content;gap:2px;align-content:start;animation:breathe 2.4s ease-in-out infinite}
.skel i{display:block;aspect-ratio:1/1;background:var(--p-tile)}
.pop{position:absolute;z-index:10;left:8px;right:8px;top:44px;max-height:min(420px,calc(100% - 60px));display:flex;flex-direction:column;border:1px solid var(--p-line);background-color:var(--p-raised);background-image:linear-gradient(var(--p-accent),var(--p-accent)),linear-gradient(var(--p-accent),var(--p-accent)),linear-gradient(var(--p-accent),var(--p-accent)),linear-gradient(var(--p-accent),var(--p-accent));background-repeat:no-repeat;background-size:8px 2px,2px 8px,8px 2px,2px 8px;background-position:left top,left top,right bottom,right bottom;box-shadow:0 1px 3px rgb(0 0 0/.18),0 8px 24px rgb(0 0 0/.28);padding:8px 4px 4px;animation:popIn 140ms var(--ease) both}
.pop .search{flex:none;display:flex;align-items:center;gap:8px;height:32px;margin:0 4px 4px;padding:0 12px;border-radius:4px;background:var(--p-field);color:var(--p-text)}
.pop .search .ic{color:var(--p-muted)}
.pop .search input{flex:1;min-width:0;height:100%;border:0;outline:0;background:transparent;color:inherit;font:inherit}
.pop .search input::placeholder{color:var(--p-faint)}
.pop .search:focus-within{border-radius:4px 4px 0 0;box-shadow:inset 0 -2px 0 var(--p-focus)}
.pop .tree{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.trow{display:flex;align-items:center;gap:4px;height:32px;padding:0 8px;border-radius:2px;white-space:nowrap;cursor:pointer}
.trow:hover{background:var(--p-hover)}
.trow .tw{width:16px;height:16px;flex:none;color:var(--p-muted);display:grid;place-items:center;border:0;background:transparent;padding:0}
.trow .ki{color:var(--p-faint)}
.trow.me .ki{color:var(--p-text)}
.trow .nm{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;overflow:hidden}
.trow .nmt{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.trow .nm.two .nmt{max-width:70%}
.trow .sec{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px;color:var(--p-faint)}
.trow .n{font-size:12px;color:var(--p-faint);font-variant-numeric:tabular-nums}
.trow .cur{width:5px;height:5px;flex:none;margin-left:8px;background:var(--p-accent)}
.trow.me .nm{font-weight:600}
.trow.kf{outline:2px solid var(--p-focus);outline-offset:-2px}
.trow.anc .nm{color:var(--p-faint)}
.trow mark{background:none;color:inherit;font-weight:700;text-decoration:underline;text-underline-offset:3px}
.pop .none{padding:12px;color:var(--p-muted)}
.prev{position:absolute;z-index:25;top:48px;bottom:48px;right:calc(100% + 16px);width:min(620px,calc(100vw - var(--panel-width) - 48px));display:flex;flex-direction:column;border:1px solid var(--p-line);background-color:var(--p-raised);background-image:linear-gradient(var(--p-accent),var(--p-accent)),linear-gradient(var(--p-accent),var(--p-accent)),linear-gradient(var(--p-accent),var(--p-accent)),linear-gradient(var(--p-accent),var(--p-accent));background-repeat:no-repeat;background-size:8px 2px,2px 8px,8px 2px,2px 8px;background-position:left top,left top,right bottom,right bottom;box-shadow:0 1px 3px rgb(0 0 0/.18),0 12px 32px rgb(0 0 0/.24);color:var(--p-text);font:400 15px/20px var(--ui);animation:popIn 140ms var(--ease) both}
.prev .ph{flex:none;display:flex;align-items:center;gap:8px;height:44px;padding:0 4px 0 12px;border-bottom:1px solid var(--p-line)}
.prev .ph .pos{font-size:12px;color:var(--p-faint);font-variant-numeric:tabular-nums}
.prev .ph .sp{flex:1;min-width:0}
.prev .ph>*:not(.sp){flex:none}
.prev .ph .pclose{width:40px;height:40px;margin-left:auto}
@media (max-width:1000px){.prev .ph .selbtn .lbl{display:none}}
.prev .stage{flex:1;min-height:0;position:relative;display:grid;place-items:center;background:color-mix(in srgb,var(--p-bg) 60%,#000 40%)}
.prev .stage img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.prev .pnav{position:absolute;top:50%;transform:translateY(-50%);width:32px;height:32px;display:grid;place-items:center;border:0;border-radius:2px;background:var(--p-scrim);color:#fff!important;padding:0}
.prev .pnav.l{left:12px}.prev .pnav.r{right:12px}
.prev .pf{flex:none;display:flex;align-items:center;height:32px;padding:0 12px;border-top:1px solid var(--p-line);font-size:12px;color:var(--p-faint);font-variant-numeric:tabular-nums}
.selbtn{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:var(--p-text)}
.selbtn:hover{background:var(--p-hover)}
.selbtn .box{width:16px;height:16px;border:1.5px solid var(--p-muted);border-radius:2px}
.selbtn .num{position:static}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@keyframes lkIn{from{opacity:0;transform:translateX(16px)}to{opacity:1;transform:none}}
@keyframes lkOut{to{opacity:0;transform:translateX(16px)}}
@keyframes popIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes breathe{50%{opacity:.55}}
.sheet-handle,.sheet-scrim,.remembered-caret,.foot-picks{display:none}
:host([data-sheet="true"]){transition:height 200ms var(--ease);transition-delay:0}
:host([data-sheet="true"]) .dock{border-radius:8px 8px 0 0;animation:sheetIn 200ms var(--ease) both;font-size:17px;line-height:22px}
:host([data-sheet="true"]) .dock.leaving{animation:sheetOut 140ms var(--ease) both}
:host([data-sheet="true"]) .clip{border-radius:8px 8px 0 0}
:host([data-sheet="true"]) .lk{top:20px;border-left:0;font-size:17px;line-height:22px;transition:opacity 140ms var(--ease) 90ms}
:host([data-sheet="true"][data-folded="true"]) .lk{transition:opacity 90ms var(--ease)}
:host([data-sheet="true"]) .sheet-handle{display:grid;place-items:center;position:absolute;z-index:21;top:0;left:0;right:0;width:100%;height:20px;padding:0;border:0;background:var(--p-bg);border-radius:8px 8px 0 0;touch-action:none;cursor:grab}
.sheet-handle span{width:36px;height:4px;border-radius:2px;background:var(--p-muted)}
:host([data-sheet="true"][data-folded="true"]) .sheet-handle{height:12px}
:host([data-sheet="true"]) .lk-head{height:56px}
:host([data-sheet="true"]) .folder{height:44px}
:host([data-sheet="true"]) .btn,:host([data-sheet="true"]) .cbtn{height:44px}
:host([data-sheet="true"]) .cbtn.sq{width:44px;height:44px}
:host([data-sheet="true"]) .lk-sub{height:48px;flex-wrap:nowrap}
:host([data-sheet="true"]) .lk-sub .scope{font-size:17px;min-height:44px}
:host([data-sheet="true"]) .sw{width:40px;height:22px;border-radius:11px}
:host([data-sheet="true"]) .sw::before{width:16px;height:16px}
:host([data-sheet="true"]) .sw.on::before{transform:translateX(18px)}
:host([data-sheet="true"]) .order{height:36px}
:host([data-sheet="true"]) .order button{font-size:13px;padding:0 10px}
:host([data-sheet="true"]) .cnt{font-size:13px}
:host([data-sheet="true"]) .num{min-width:24px;height:24px;font-size:13px;line-height:24px}
:host([data-sheet="true"]) .tray{display:none}
:host([data-sheet="true"]) .foot{height:72px;gap:8px;padding:0 12px}
:host([data-sheet="true"]) .foot .btn,:host([data-sheet="true"]) .foot .cbtn{height:44px;font-size:17px}
:host([data-sheet="true"]) .foot .picks-present{width:44px;justify-content:center}
:host([data-sheet="true"]) .foot .sp,:host([data-sheet="true"]) .kb{display:none}
:host([data-sheet="true"]) .foot-picks{display:flex;flex:1;gap:8px;min-width:0;overflow-x:auto;scrollbar-width:none}
:host([data-sheet="true"]) .rail-thumb,:host([data-sheet="true"]) .foot-thumb{width:48px;height:48px}
:host([data-sheet="true"]) .rail-thumb .num,:host([data-sheet="true"]) .foot-thumb .num{min-width:24px;height:24px;line-height:24px;font-size:13px}
:host([data-sheet="true"]) .job{max-height:192px;order:2;padding:0 12px 4px}
:host([data-sheet="true"]) .slab{height:44px}
:host([data-sheet="true"]) :is(.slab,.jr .st small,.foot .busy,.empty small,.trow .sec,.trow .n,.tree-section,.prev .pf,.done){font-size:13px}
:host([data-sheet="true"]) .foot{order:3}
:host([data-sheet="true"]) .jr{height:48px}
:host([data-sheet="true"]) .jr .cbtn{height:44px}
:host([data-sheet="true"]) .rail{top:12px;bottom:0;left:0;right:0;width:100%;height:60px;flex-direction:row;gap:8px;padding:0 12px;border-left:0;transition:opacity 90ms var(--ease)}
:host([data-sheet="true"][data-folded="true"]) .rail{transition:opacity 140ms var(--ease) 90ms}
:host([data-sheet="true"]) .rail-items{flex-direction:row;width:auto;height:48px;gap:8px}
:host([data-sheet="true"]) .rail .btn{width:auto;height:44px;padding:0 16px}
:host([data-sheet="true"]) .rail-count,:host([data-sheet="true"]) .rail-more{font-size:13px;white-space:nowrap}
:host([data-sheet="true"]) .rail .sq{display:none}
:host([data-sheet="true"]) .sheet-scrim{display:block;position:absolute;bottom:100%;left:0;right:0;height:36px;background:rgb(0 0 0/.5);opacity:0;pointer-events:none;transition:opacity 140ms var(--ease)}
:host([data-sheet="true"][data-full="true"]) .sheet-scrim{opacity:1;pointer-events:auto}
:host([data-sheet="true"]) .remembered-caret{display:block;position:fixed;width:2px;background:var(--p-accent);pointer-events:none}
:host([data-sheet="true"]) .pop{top:72px;max-height:calc(100% - 150px);font-size:17px}
:host([data-sheet="true"]) .pop .search,:host([data-sheet="true"]) .trow{height:44px}
:host([data-sheet="true"]) .trow .tw{width:44px;height:44px}
:host([data-sheet="true"]) .prev{position:fixed;left:12px;right:12px;width:auto;top:12px;bottom:calc(var(--sheet-height) + 12px);font-size:17px}
:host([data-sheet="true"]) .prev .ph{height:52px}
:host([data-sheet="true"]) .prev .ph .pos{font-size:13px}
:host([data-sheet="true"]) .prev .ph .pclose,:host([data-sheet="true"]) .prev .pnav,:host([data-sheet="true"]) .selbtn{min-width:44px;height:44px}
:host([data-sheet="true"]) .prev .ph .selbtn .lbl{display:inline}
:host([data-sheet="true"]) .prev .stage img{position:absolute;width:100%;height:100%}
@media(pointer:coarse){.pv{opacity:1;width:44px;height:44px;background:transparent;right:0;bottom:0}.pv::before{content:"";position:absolute;inset:8px;background:var(--p-scrim);border-radius:2px}.pv .ic{position:relative}}
@keyframes sheetIn{from{transform:translateY(100%)}to{transform:translateY(0)}}
@keyframes sheetOut{to{transform:translateY(100%)}}
@media(prefers-reduced-motion:reduce){.dock,.dock.leaving,.pop,.prev,.skel{animation:none}:host,.lk,.rail,.tray,.sw::before,.chk,.pv{transition:none!important}}
@media(prefers-reduced-motion:reduce){:host([data-sheet="true"]) .dock,:host([data-sheet="true"]) .dock.leaving{animation:none}:host([data-sheet="true"]) .sheet-scrim,:host([data-sheet="true"]) .lk,:host([data-sheet="true"]) .rail{transition:none}}
@media(forced-colors:active){.lk{border-left:1px solid CanvasText;background:Canvas;color:CanvasText}.tile.sel::after{box-shadow:inset 0 0 0 3px Highlight}.num,.btn.primary{background:Highlight;color:HighlightText;border-color:Highlight}}
`;
