(() => {
  "use strict";
  const OPEN_DISTANCE_PX = 12;
  const TOUCH_LONG_PRESS_MS = 420;

  function runtimeTimeoutMs(message) {
    if (message?.type !== "collector:save") return 15_000;
    return message?.payload?.candidate?.type === "video" ? 310_000 : 70_000;
  }

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => finish({ ok: false, code: "worker_timeout" }), runtimeTimeoutMs(message));
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value ?? { ok: false, code: "worker_failed" });
      };
      try {
        // Chromium/Titanium can expose a Promise even when a callback is supplied.
        // That Promise may resolve to undefined before sendResponse arrives, so the
        // callback is the single authority for this callback-form invocation.
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime?.lastError) finish({ ok: false, code: "worker_failed" });
          else finish(response);
        });
      } catch { finish({ ok: false, code: "worker_failed" }); }
    });
  }

  function createInvocationGate() {
    let phase = "idle", pointerId = null;
    return {
      get phase() { return phase; },
      arm(id) { if (phase !== "idle") return false; phase = "armed"; pointerId = id; return true; },
      opening(id) { if (phase !== "armed" || pointerId !== id) return false; phase = "opening"; return true; },
      opened(id) { if (phase !== "opening" || pointerId !== id) return false; phase = "list-open"; return true; },
      release(id) { if (pointerId !== id) return false; pointerId = null; if (phase === "armed" || phase === "opening") phase = "idle"; return true; },
      close() { phase = "idle"; pointerId = null; },
    };
  }

  function findCandidate(target) {
    return globalThis.LakomicsForumSource?.findCandidate(target)
      ?? globalThis.LakomicsXSource?.findCandidate(target)
      ?? globalThis.LakomicsForumSource?.findGenericCandidate(target) ?? null;
  }

  function plainCandidate(candidate) {
    return {
      source: candidate?.source ?? "web", filename: candidate?.filename ?? null,
      type: candidate?.type ?? "image", mediaUrl: candidate?.mediaUrl ?? null,
      sourceUrl: candidate?.sourceUrl ?? location.href, author: candidate?.author ?? null,
      postId: candidate?.postId ?? null, mediaIndex: candidate?.mediaIndex ?? null,
      publishedAt: candidate?.publishedAt ?? null,
    };
  }

  function temporaryIntent(candidate) {
    if (!candidate || candidate.type === "video" || !candidate.mediaUrl) return null;
    try {
      const url = new URL(candidate.mediaUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
      return `intent://temporary?url=${encodeURIComponent(url.href)}#Intent;scheme=lakomics;package=com.lakomics.mobile;end`;
    } catch { return null; }
  }

  function point(event) { return { x: event.clientX, y: event.clientY }; }
  function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function inputKind(event) {
    if (event.pointerType === "touch") return "touch";
    if ((event.pointerType === "mouse" || !event.pointerType) && event.button === 0) return "mouse";
    return null;
  }

  function shouldSuppressNativeContext(active, phase) {
    return Boolean(active?.input === "touch" || active?.longPressed || phase === "opening" || phase === "list-open");
  }

  function saveResultMessage(result) {
    if (!result?.ok) return "저장 실패";
    if (result.localOnly) return "기기 다운로드";
    const remote = result.captureStatus === "imported" ? "PC 반영 완료" : "PC 수신 대기";
    if (result.status === "duplicate") return `서버에 이미 있음 · ${remote}`;
    if (result.status === "confirmed") return `서버 저장 확인됨 · ${remote}`;
    return `서버 저장됨 · ${remote}`;
  }

  function saveFailureMessage(result) {
    if (!result) return "서버 저장 실패";
    if (result.code === "revoked") return "다시 연결 필요";
    if (result.code === "classification_stale") return "분류 목록 갱신 필요";
    if (result.code === "timeout" || result.code === "worker_timeout") return "서버 응답 시간 초과";
    if (result.code === "offline" || result.code === "server_offline") return "서버 연결 실패";
    if (result.code === "media_unsupported") return "지원하지 않는 미디어";
    const detail = String(result.serverDetail || "");
    if (/^Invalid source URL$/i.test(detail)) return "서버 거절 · 원문 URL 검증 실패";
    if (/^Unsupported content type:/i.test(detail)) return `서버 거절 · 원본 형식 ${detail.split(":", 2)[1]?.trim() || "알 수 없음"}`;
    if (/^Unsupported .* media URL$/i.test(detail)) return "서버 거절 · 미디어 URL 검증 실패";
    if (/^Unsupported .* media host$/i.test(detail)) return "서버 거절 · 미디어 호스트 검증 실패";
    if (/^Media host could not be resolved$/i.test(detail)) return "서버 원본 수신 실패 · DNS 확인 실패";
    if (/^Private or special-use media host is not allowed$/i.test(detail)) return "서버 거절 · 원본 주소 보안 검증 실패";
    if (/^Media connection address was not validated$/i.test(detail)) return "서버 거절 · 원본 서버 주소 검증 실패";
    if (/^Media host address changed during download$/i.test(detail)) return "서버 거절 · 원본 서버 주소 변경 감지";
    if (/^Empty .* response$/i.test(detail)) return "서버 원본 수신 실패 · 빈 응답";
    if (/ is too large$/i.test(detail)) return "서버 거절 · 원본 파일 용량 초과";
    const upstream = detail.match(/^Media returned HTTP (\d{3})$/i);
    if (upstream) return `서버 원본 수신 실패 · HTTP ${upstream[1]}`;
    if (detail) return `${result.httpStatus === 502 ? "서버 원본 수신 실패" : "서버 거절"} · ${detail}`;
    return result.httpStatus ? `서버 저장 실패 · HTTP ${result.httpStatus}` : "서버 저장 실패";
  }

  function normalizePostId(value) { const text = String(value ?? "").trim(); return /^\d+$/.test(text) ? text : ""; }
  function findTweetArticle(root, postId) {
    const targetId = normalizePostId(postId); if (!targetId) return null;
    for (const article of root?.querySelectorAll?.('article[data-testid="tweet"]') ?? []) {
      for (const link of article.querySelectorAll?.('a[href*="/status/"]') ?? []) {
        const match = String(link.getAttribute?.("href") || link.href || "").match(/\/status\/(\d+)/);
        if (match?.[1] === targetId) return article;
        if (match) break;
      }
    }
    return null;
  }
  async function autoLike(postId) {
    const article = findTweetArticle(document, postId);
    if (!article || article.querySelector?.('[data-testid="unlike"]')) return;
    const node = article.querySelector?.('[data-testid="like"]');
    const button = node?.closest?.('button,[role="button"]') ?? node;
    try { button?.click?.(); } catch {}
  }

  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsListContent = { createInvocationGate, temporaryIntent, plainCandidate, shouldSuppressNativeContext, runtimeTimeoutMs, saveResultMessage, saveFailureMessage, normalizePostId };
    return;
  }

  install();
  function install() {
    const gate = createInvocationGate();
    let active = null;
    let longPressTimer = null;
    let picker = null;
    let statePromise = null;
    let suppressNextClick = false;
    let toast = null, toastTimer = null;
    let gestureTarget = null;

    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onCancel, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("selectstart", onSelectStart, true);
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !picker) reset(); }, true);

    function insidePicker(event) { return Boolean(picker && event.composedPath?.().includes(picker.host)); }
    function clearTimer() { if (longPressTimer !== null) clearTimeout(longPressTimer); longPressTimer = null; }
    function clearTouchOwnership() {
      document.documentElement.classList.remove("lakomics-list-touch-active");
      gestureTarget?.classList?.remove("lakomics-list-gesture-target");
      gestureTarget = null;
    }
    function reset() { clearTimer(); clearTouchOwnership(); active = null; gate.close(); }

    function onDown(event) {
      if (insidePicker(event) || gate.phase !== "idle") return;
      const input = inputKind(event); if (!input) return;
      const candidate = findCandidate(event.target); if (!candidate) return;
      if (!gate.arm(event.pointerId)) return;
      const origin = point(event);
      active = { id: event.pointerId, input, candidate, origin, latest: origin };
      if (input === "touch") {
        document.documentElement.classList.add("lakomics-list-touch-active");
        gestureTarget = candidate.element || event.target;
        gestureTarget?.classList?.add("lakomics-list-gesture-target");
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          if (active?.id !== event.pointerId) return;
          active.longPressed = true;
          suppressNextClick = true;
          try { event.preventDefault(); } catch {}
          void open(active);
        }, TOUCH_LONG_PRESS_MS);
      }
    }

    function onMove(event) {
      if (!active || active.id !== event.pointerId || gate.phase !== "armed") return;
      active.latest = point(event);
      if (active.input === "touch") {
        if (distance(active.origin, active.latest) > 20) reset();
        return;
      }
      if (distance(active.origin, active.latest) >= OPEN_DISTANCE_PX) {
        event.preventDefault(); event.stopPropagation(); void open(active);
      }
    }

    function onUp(event) {
      if (!active || active.id !== event.pointerId) return;
      clearTimer();
      if (gate.phase === "armed") {
        gate.release(event.pointerId); clearTouchOwnership(); active = null; return;
      }
      // Once opening has started, releasing the trigger pointer must not cancel
      // the asynchronous state load. The list owns the session until it closes.
      active.released = true;
      suppressNextClick = true;
      event.preventDefault(); event.stopImmediatePropagation();
    }
    function onCancel(event) {
      if (!active || active.id !== event.pointerId) return;
      clearTimer();
      if (gate.phase === "armed") { reset(); return; }
      active.released = true;
      suppressNextClick = true;
    }
    function onClick(event) {
      if (insidePicker(event)) return;
      if (!suppressNextClick) return;
      suppressNextClick = false; event.preventDefault(); event.stopImmediatePropagation();
    }
    function onContextMenu(event) {
      if (insidePicker(event)) return;
      if (shouldSuppressNativeContext(active, gate.phase)) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }
    function onSelectStart(event) {
      if (insidePicker(event)) return;
      if (shouldSuppressNativeContext(active, gate.phase)) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }
    function onDragStart(event) { if (gate.phase !== "idle" && findCandidate(event.target)) event.preventDefault(); }

    async function loadState() {
      if (statePromise) return statePromise;
      const promise = runtimeMessage({ type: "collector:state" }).finally(() => { if (statePromise === promise) statePromise = null; });
      statePromise = promise; return promise;
    }

    async function open(session) {
      if (!active || active !== session || !gate.opening(session.id)) return;
      clearTimer();
      const response = await loadState();
      if (!active || active !== session || gate.phase !== "opening") return;
      if (!response?.ok || !response.state?.classifications?.entries?.length) {
        gate.release(session.id); clearTouchOwnership(); active = null;
        showStatus(response?.code === "unpaired" ? "연결 필요" : "연결 실패", "error");
        if (response?.code === "unpaired") void chrome.runtime.sendMessage({ type: "settings:get" }).finally(() => chrome.runtime.openOptionsPage?.());
        return;
      }
      if (!gate.opened(session.id)) return;
      const state = response.state;
      const candidate = plainCandidate(session.candidate);
      const temporary = temporaryIntent(candidate);
      picker = globalThis.LakomicsListCollector.mount({
        entries: state.classifications.entries,
        profile: state.profile,
        origin: session.origin,
        onTemporary: temporary ? () => { window.location.href = temporary; return true; } : null,
        onSave: async (classificationId) => {
          const model = globalThis.LakomicsClassificationTree.createModel(state.classifications.entries, state.profile);
          const classificationPath = model.path(classificationId).map((entry) => entry.name);
          const result = await runtimeMessage({ type: "collector:save", payload: { candidate, classificationId, classificationPath } });
          if (result?.ok) {
            if (candidate.source === "x" && state.profile.preferences.autoLikeOnSave !== false && candidate.postId) void autoLike(candidate.postId);
            globalThis.LakomicsXGalleryRuntime?.markSaved?.(candidate.mediaUrl, { status: result.status, postId: candidate.postId, mediaIndex: candidate.mediaIndex, sourceUrl: candidate.sourceUrl });
            return { ok: true, message: saveResultMessage(result) };
          }
          const message = saveFailureMessage(result);
          showStatus(message, "error", 5200);
          return { ok: false, message };
        },
        onClose: (result) => {
          picker = null; gate.close(); clearTouchOwnership(); active = null; suppressNextClick = false;
          if (result?.ok) showStatus(result.message || "저장됨", "success");
        },
      });
    }

    function showStatus(message, kind, durationMs = 2200) {
      toast?.remove(); if (toastTimer) clearTimeout(toastTimer);
      toast = document.createElement("div"); toast.className = `lakomics-list-toast ${kind || ""}`; toast.textContent = message;
      document.documentElement.append(toast);
      toastTimer = setTimeout(() => { toast?.remove(); toast = null; toastTimer = null; }, durationMs);
    }
  }
})();
