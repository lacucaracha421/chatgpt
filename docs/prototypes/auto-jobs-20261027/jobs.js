// Mockup behaviour and stand-in data for Settings › 자동 작업. Not app code.
// "Now" is 2026-10-27 15:02. Times follow displayDateTime: today = "14:20", yesterday = "어제 23:10", else "10.25 03:00".
(() => {
  const esc = (s) => String(s);
  const danger = (s) => `<span class="settings-view__state" data-tone="danger">${s}</span>`;
  const num = (s) => `<span class="numeric">${s}</span>`;
  const bar = (pct) => `<span class="auto-job__bar" aria-hidden="true"><i style="width:${pct}%"></i></span>`;
  const check = `<svg class="i auto-job__check" aria-hidden="true"><use href="#i-check"/></svg>`;

  // group: new 새 정보 · analysis 분석 · prep 준비 · tidy 정리. heavy = pauses in 절약 모드.
  const JOBS = [
    { id: "catalog", group: "new", name: "온라인 카탈로그", toggle: true, status: `${num("14:20")} · 새 작품 ${num("32")}개`, interval: "1시간마다", next: `다음 ${num("15:20")}`, action: "지금 갱신", busy: "갱신 중…", done: `${num("15:03")} · 새 작품 ${num("4")}개` },
    { id: "calendar", group: "new", name: "발매 캘린더", status: `${num("06:00")} · 새 일정 ${num("9")}개`, cadence: "매일 06:00", action: "지금 갱신", busy: "갱신 중…", done: `${num("15:03")} · 새 일정 ${num("1")}개` },
    { id: "wish", group: "new", name: "찜·신간 발매 확인", failed: true, status: `${danger("실패")} · MangaDex 응답 없음 · ${num("14:30")}`, cadence: "1시간마다", next: `다음 ${num("15:30")}`, action: "다시 시도", busy: "확인 중…", done: `${num("15:03")} · 신간 ${num("2")}권 · 발매일 바뀜 ${num("1")}개` },
    { id: "games", group: "new", name: "게임 정보 (LaunchBox)", heavy: true, running: { text: `받는 중 ${num("1,204")} / ${num("3,000")}`, pct: 40 }, cadence: "매주 월요일", next: `시작 ${num("14:48")}`, action: "중지", status: `10.20 · 게임 ${num("2,981")}개`, done: `${num("15:03")} · 게임 ${num("3,000")}개` },

    { id: "autotag", group: "analysis", name: "자동 태그 가져오기", status: `${num("15:00")} · 이미지 ${num("48")}장`, cadence: "5분마다", next: `다음 ${num("15:05")}`, action: "지금 가져오기", busy: "가져오는 중…", done: `${num("15:03")} · 새 파일 없음` },
    { id: "character", group: "analysis", name: "캐릭터 자동 분류", heavy: true, toggle: true, status: `${num("14:58")} · ${num("23")}장 분류`, cadence: "새 이미지가 들어오면", next: "대기 없음", action: "지금 실행", busy: "분류 중…", done: `${num("15:03")} · 대기 없음` },
    { id: "similar", group: "analysis", name: "유사 이미지 준비", heavy: true, status: `${num("14:58")} · 이미지 ${num("23")}장`, cadence: "새 이미지가 들어오면", next: "대기 없음", action: "지금 실행", busy: "준비 중…", done: `${num("15:03")} · 대기 없음` },

    { id: "video", group: "prep", name: "영상 미리보기 준비", heavy: true, status: `어제 ${num("23:10")} · 영상 ${num("5")}개`, cadence: "새 영상이 들어오면", next: `대기 ${num("3")}개`, action: "지금 실행", busy: "준비 중…", done: `${num("15:03")} · 영상 ${num("3")}개` },
    { id: "spine", group: "prep", name: "만화 책등 스캔 받기", status: `10.25 · ${num("17")}권 받음 · 못 찾음 ${num("6")}권`, cadence: "새 권이 들어오면", next: "대기 없음", action: "지금 받기", busy: "받는 중…", done: `${num("15:03")} · 새로 찾은 것 없음` },
    { id: "cards", group: "prep", name: "카드 누끼 만들기", heavy: true, status: `10.24 · 카드 ${num("12")}장`, cadence: "새 카드가 들어오면", next: "대기 없음", action: "지금 만들기", busy: "만드는 중…", done: `${num("15:03")} · 대기 없음` },
    { id: "cloud", group: "prep", name: "클라우드 복제", toggle: true, status: `${num("15:01")} · 올림 ${num("46")}개`, cadence: "바뀌면 바로", next: `대기 ${num("12")}개 · ${danger(`실패 ${num("4")}개`)}`, action: "지금 동기화", busy: "동기화 중…", done: `${num("15:03")} · 올림 ${num("12")}개 · 실패 ${num("4")}개` },

    { id: "backup", group: "tidy", name: "관리 정보 백업", status: `${num("03:00")} · 18.4 MB`, cadence: "매일 03:00", action: "지금 백업", busy: "백업 중…", done: `${num("15:03")} · 18.4 MB` },
    { id: "trash", group: "tidy", name: "휴지통 자동 비우기", status: `${num("03:00")} · ${num("7")}개 영구 삭제`, cadence: "매일 03:00", next: `30일 지난 것 ${num("4")}개`, action: "만료분 비우기", confirm: true },
  ];
  const GROUPS = [["new", "새 정보"], ["analysis", "분석"], ["prep", "준비"], ["tidy", "정리"]];
  const HELP = { prep: true };

  // 절약 모드: heavy jobs wait and say so in the cadence line; a running heavy job stops where it is.
  function inMode(job, mode) {
    if (mode !== "saver" || !job.heavy) return job;
    const waiting = { character: `대기 ${num("128")}장`, similar: `대기 ${num("128")}장`, video: `대기 ${num("3")}개`, cards: "대기 없음" };
    if (job.id === "games") return { ...job, running: null, status: `${num("1,204")} / ${num("3,000")}에서 멈춤`, paused: 40, cadence: "절약 모드", next: "끄면 이어서", action: "지금 갱신", busy: "받는 중…" };
    return { ...job, cadence: "절약 모드", next: waiting[job.id] ?? job.next, interval: null };
  }

  function row(job, opts = {}) {
    const state = job.failed ? "failed" : job.running ? "running" : job.off ? "off" : "idle";
    const status = job.running ? `${job.running.pct != null ? "" : ""}<span class="auto-job__text">${job.running.text}</span>${job.running.pct != null ? bar(job.running.pct) : ""}`
      : job.paused != null ? `<span class="auto-job__text">${job.status}</span>${bar(job.paused)}`
      : `<span class="auto-job__text">${job.status}</span>${job.justDone ? check : ""}`;
    const cadence = job.interval
      ? `<dd class="auto-job__cadence"><button type="button" class="auto-job__interval" aria-haspopup="menu" aria-label="갱신 간격 ${job.interval}">${job.interval}<svg class="i" aria-hidden="true"><use href="#i-chev-down"/></svg></button></dd>`
      : `<dd class="auto-job__cadence${job.next ? "" : " is-single"}">${job.cadence ?? ""}</dd>`;
    const next = job.next ? `<dd class="auto-job__next">${job.next}</dd>` : "";
    const sw = job.toggle ? `<dd class="auto-job__switch"><input type="checkbox" role="switch" class="ui-switch" aria-label="${job.name} 자동 실행"${job.off ? "" : " checked"}${job.toggleDisabled ? " disabled" : ""}></dd>` : `<dd class="auto-job__switch"></dd>`;
    const variant = job.actionVariant ?? "quiet";
    const act = `<dd class="auto-job__action"><button type="button" class="ui-button ui-button--${variant} ui-button--sm" data-job="${job.id}"${job.actionDisabled ? " disabled" : ""}>${job.action}</button></dd>`;
    const cls = ["settings-view__property", "settings-view__property--job", "auto-job", job.justDone ? "is-done" : "", opts.rising ? "is-rising" : ""].filter(Boolean).join(" ");
    return `<dl class="${cls}" data-state="${state}" data-id="${job.id}"><dt><span>${job.name}</span></dt><dd class="settings-view__status">${status}</dd>${cadence}${next}${sw}${act}</dl>`;
  }

  function label(title, { count, help } = {}) {
    const helpBtn = help ? `<span class="ui-section-label__actions"><button type="button" class="ui-button ui-button--ghost ui-button--icon" aria-label="${title} 도움말"><svg class="i" aria-hidden="true"><use href="#i-info"/></svg></button></span>` : "";
    return `<h3 class="ui-section-label"><span class="ui-section-label__title">${title}</span>${count != null ? ` <span class="ui-section-label__count">${count}</span>` : ""}<span class="ui-section-label__rule" aria-hidden="true"></span>${helpBtn}</h3>`;
  }

  function section(jobs, mode) {
    const list = jobs.map((job) => inMode(job, mode));
    const failed = list.filter((job) => job.failed);
    const heavyCount = list.filter((job) => job.heavy).length;
    let html = "";
    if (mode === "saver") html += `<div class="auto-jobs__saver"><dl class="settings-view__property"><dt><span>절약 모드</span></dt><dd class="settings-view__status">무거운 작업 ${num(heavyCount)}개 쉬는 중</dd><dd class="settings-view__inline-controls"><input type="checkbox" role="switch" class="ui-switch" aria-label="절약 모드" checked></dd></dl></div>`;
    if (failed.length) html += `<section class="settings-view__group">${label("실패", { count: failed.length })}${failed.map((job) => row(job)).join("")}</section>`;
    for (const [key, title] of GROUPS) {
      const rows = list.filter((job) => job.group === key && !job.failed);
      html += `<section class="settings-view__group">${label(title, { help: HELP[key] })}${rows.map((job) => row(job)).join("")}</section>`;
    }
    return html;
  }

  const ICON = (id) => `<svg class="i" aria-hidden="true"><use href="#${id}"/></svg>`;
  const NAV = [["i-star", "자주 쓰는 것"], ["i-auto", "자동 작업"], ["i-desktop", "화면"], ["i-folder", "라이브러리"], ["i-link", "연결"], ["i-globe", "카탈로그"], ["i-lock", "보관함"], ["i-wrench", "고급"]];
  const RAIL = [["i-home", "홈"], ["i-photo", "에셋"], ["i-stack", "컬렉션"], ["i-book", "망가"], ["i-pencil", "메모"], ["i-updown", "전송"]];

  function shell(mode, jobs) {
    const rail = `<nav class="workspace-rail" aria-label="주요 영역"><span class="workspace-mark"><span></span></span>${RAIL.map(([i, l]) => `<button type="button" class="workspace-rail__item"><span class="workspace-rail__icon">${ICON(i)}</span><span>${l}</span></button>`).join("")}<div class="workspace-rail__tail"><button type="button" class="workspace-rail__item"><span class="workspace-rail__icon">${ICON("i-search")}</span><span>찾기</span></button><button type="button" class="workspace-rail__item" aria-current="page"><span class="workspace-rail__icon">${ICON("i-more")}</span><span>더보기</span></button></div></nav>`;
    const index = `<aside class="workspace-index" aria-label="탐색 인덱스"><header class="workspace-index__head"><span class="workspace-index__title">설정</span></header><div class="workspace-index__scroll"><div class="workspace-index__view-navigation"><nav class="settings-view__navigation" aria-label="설정 구역">${NAV.map(([i, l]) => `<button type="button" class="ui-button ui-button--ghost ui-button--md settings-view__section-button"${l === "자동 작업" ? ' aria-current="page"' : ""}>${ICON(i).replace('class="i"', 'class="i settings-view__section-icon"')}${l}</button>`).join("")}</nav></div></div></aside>`;
    const indicator = mode === "saver" ? `<button type="button" class="lightweight-mode-indicator" aria-label="절약 모드 끄기">${ICON("i-pause")}<span>절약 모드</span></button>` : "";
    const titlebar = `<header class="workspace-titlebar"><div class="workspace-titlebar__context"><div class="view-toolbar view-toolbar--context"><h2>자동 작업</h2></div></div>${indicator}<span class="win" aria-hidden="true">— ▢ ✕</span></header>`;
    const content = `<div class="settings-view"><div class="settings-view__body settings-view__body--integrated"><div class="settings-view__content"><div class="settings-view__section" data-section>${section(jobs, mode)}</div></div></div></div>`;
    return `${rail}${index}<main class="mock-main">${titlebar}${content}</main>`;
  }

  const DIALOG = `<div class="ui-dialog__overlay" data-dialog></div><div class="ui-dialog" role="alertdialog" aria-labelledby="trash-confirm-title" data-dialog>
    <div class="auto-job-confirm"><div class="auto-job-confirm__thumbs" aria-hidden="true"><span><i class="ph" style="--h:20"></i></span><span><i class="ph" style="--h:210"></i></span></div>
    <div><h2 class="ui-dialog__title" id="trash-confirm-title">기간이 지난 ${num("4")}개를 영구 삭제할까요?</h2><p>30일 지난 것만 · 휴지통의 나머지 ${num("41")}개는 그대로</p></div></div>
    <div class="ui-dialog__actions"><button type="button" class="ui-button ui-button--secondary ui-button--md" data-close>취소</button><button type="button" class="ui-button ui-button--danger ui-button--md" data-confirm>영구 삭제</button></div></div>`;

  // Each frame keeps its own copy, so clicking in one frame never changes another.
  const state = {};
  const jobsOf = (frame) => (state[frame.id] ??= JOBS.map((j) => ({ ...j })));

  function mount(frame) {
    const mode = frame.dataset.mode;
    frame.innerHTML = shell(mode, jobsOf(frame));
    if (frame.hasAttribute("data-dialog-open")) frame.insertAdjacentHTML("beforeend", DIALOG);
  }

  // Simulated manual run: nothing changes for the first 400 ms (the button only disables), then the busy
  // label shows, then the result lands in one step with the success tint.
  function run(frame, id) {
    const mode = frame.dataset.mode;
    const job = jobsOf(frame).find((j) => j.id === id);
    const el = () => frame.querySelector(`[data-id="${id}"]`);
    if (job.confirm) { frame.insertAdjacentHTML("beforeend", DIALOG); return; }
    if (job.running) { Object.assign(job, { running: null, status: `${num("1,204")} / ${num("3,000")}에서 중지`, paused: 40, action: "이어 받기", busy: "받는 중…" }); mount(frame); return; }
    el().querySelector("button[data-job]").disabled = true;
    const busyTimer = setTimeout(() => { const s = el().querySelector(".auto-job__text"); if (s) s.innerHTML = job.busy; }, 400);
    setTimeout(() => {
      clearTimeout(busyTimer);
      Object.assign(job, { status: job.done, failed: false, running: null, paused: null, justDone: true, action: job.id === "wish" ? "지금 확인" : job.id === "games" ? "지금 갱신" : job.action });
      mount(frame);
      setTimeout(() => { job.justDone = false; }, 0);
    }, 2000);
  }

  document.querySelectorAll("[data-frame]").forEach((frame) => {
    mount(frame);
    frame.addEventListener("click", (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      if (button.matches("[data-close]")) { frame.removeAttribute("data-dialog-open"); frame.querySelectorAll(".ui-dialog__overlay, .ui-dialog").forEach((n) => n.remove()); return; }
      if (button.matches("[data-confirm]")) {
        frame.removeAttribute("data-dialog-open");
        frame.querySelectorAll(".ui-dialog__overlay, .ui-dialog").forEach((n) => n.remove());
        const job = jobsOf(frame).find((j) => j.id === "trash");
        Object.assign(job, { status: `${num("15:03")} · ${num("4")}개 영구 삭제`, next: "30일 지난 것 없음", actionDisabled: true, justDone: true });
        mount(frame); setTimeout(() => { job.justDone = false; }, 0); return;
      }
      if (button.dataset.job && frame.hasAttribute("data-live")) run(frame, button.dataset.job);
    });
  });

  // State specimens (part D): the same row in each state, rendered with the same row().
  const base = Object.fromEntries(JOBS.map((j) => [j.id, j]));
  const SPEC = [
    ["쉬는 중", "기본", { ...base.catalog }],
    ["누른 뒤 400 ms 안", "버튼만 잠김, 글자는 그대로", { ...base.catalog, actionDisabled: true }],
    ["실행 중 · 전체를 모름", "400 ms 뒤에 바뀜", { ...base.catalog, status: "갱신 중…", actionDisabled: true }],
    ["실행 중 · 전체를 앎", "회색 48×4 막대", { ...base.games }],
    ["끝남", "줄이 잠깐 초록빛, 체크가 스며듦", { ...base.catalog, status: base.catalog.done, justDone: true }],
    ["실패", "실패 묶음으로 올라감", { ...base.catalog, failed: true, status: `${danger("실패")} · 서버 응답 없음 · ${num("15:03")}`, action: "다시 시도", interval: null, cadence: "1시간마다", next: `다음 ${num("16:03")}` }],
    ["절약 모드 대기", "무거운 작업만", { ...inMode(base.character, "saver") }],
    ["꺼짐", "지금 실행은 한 번 돎", { ...base.catalog, off: true, interval: null, cadence: "꺼짐", next: null }],
    ["설정 필요 · 폴더", "", { ...base.autotag, status: "가져올 폴더 없음", cadence: "5분마다", next: null, action: "폴더 선택" }],
    ["설정 필요 · 서버", "", { ...base.cloud, status: "서버 연결 안 됨", next: null, cadence: "바뀌면 바로", toggleDisabled: true, off: true, action: "연결 설정" }],
    ["대기 수", "실패 수만 빨강", { ...base.cloud }],
    ["비울 것 없음", "", { ...base.trash, next: "30일 지난 것 없음", actionDisabled: true }],
  ];
  const spec = document.getElementById("spec");
  if (spec) spec.innerHTML = SPEC.map(([t, n, job]) => `<div class="spec-item"><p class="tag">${t}${n ? ` · ${n}` : ""}</p>${row(job)}</div>`).join("");

  // Live demo keys (part A): restart the frame.
  document.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", () => {
    const frame = document.getElementById(b.dataset.reset);
    state[frame.id] = JOBS.map((j) => ({ ...j }));
    mount(frame);
  }));
})();

// index.html#only=part-B shows one part, for screenshots.
(() => {
  const m = location.hash.match(/only=([\w-]+)/);
  if (!m) return;
  document.querySelectorAll(".doc > header, .doc > .part").forEach((n) => { if (n.id !== m[1]) n.hidden = true; });
})();
