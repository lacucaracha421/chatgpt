(() => {
  "use strict";

  function createCollectorController({ send, status, snapshot = () => {}, close = () => {}, saved = () => {} }) {
    let active = null;
    let failedPayload = null;

    function begin(candidate, origin, entries, layout, pinnedIds = [], classificationSource = "app", options = {}) {
      active = {
        candidate,
        entries,
        classificationSource,
        session: globalThis.LakomicsGesture.createSession(origin, entries, layout, pinnedIds, options),
      };
      return active.session.snapshot();
    }

    function move(point, time) {
      if (!active) return null;
      const next = active.session.move(point, time);
      snapshot(next);
      return next;
    }

    function tick(time) {
      if (!active) return null;
      const next = active.session.tick(time);
      snapshot(next);
      return next;
    }

    async function release() {
      if (!active) return { type: "idle" };
      const current = active;
      const action = current.session.release();
      active = null;
      close();
      if (action.type !== "select") return action;
      return submit(payloadFor(current, action.classificationId));
    }

    function activate() {
      if (!active) return { type: "idle" };
      const current = active;
      const action = current.session.activate();
      if (action.type === "expand" || action.type === "pending") {
        snapshot(current.session.snapshot());
        return action;
      }
      active = null;
      close();
      if (action.type === "select") void submit(payloadFor(current, action.classificationId));
      return action;
    }

    function payloadFor(current, classificationId) {
      const classification = current.entries.find((entry) => entry.id === classificationId);
      return {
        source: "x",
        mediaType: current.candidate.type ?? "image",
        mediaUrl: current.candidate.mediaUrl ?? null,
        sourceUrl: current.candidate.sourceUrl,
        author: current.candidate.author ?? null,
        postId: current.candidate.postId ?? null,
        mediaIndex: current.candidate.mediaIndex ?? null,
        classificationId,
        classificationName: classification?.name ?? "기타",
        classificationPath: classificationPath(current.entries, classificationId),
        classificationSource: current.classificationSource,
      };
    }

    function classificationPath(entries, classificationId) {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const names = [];
      const seen = new Set();
      let current = byId.get(classificationId) ?? null;
      while (current && !seen.has(current.id) && names.length < 8) {
        seen.add(current.id);
        if (current.name) names.unshift(current.name);
        current = current.parentId ? byId.get(current.parentId) ?? null : null;
      }
      return names;
    }

    function cancel() {
      active = null;
      close();
    }

    async function retry() {
      if (!failedPayload) return { ok: false, code: "nothing_to_retry" };
      return submit({ ...failedPayload });
    }

    async function submit(payload) {
      status("저장 중…", false, "progress");
      let response;
      try {
        response = await send(payload);
      } catch {
        response = { ok: false, code: "worker_failed" };
      }
      const feedback = feedbackFor(response);
      if (response.ok) failedPayload = null;
      else if (feedback.retry) failedPayload = { ...payload };
      else failedPayload = null;
      status(feedback.message, feedback.retry, feedback.kind);
      if (isSavedResponse(response)) saved(payload, response);
      return response;
    }

    return { begin, move, tick, release, activate, cancel, retry };
  }

  function isSavedResponse(response) {
    return Boolean(response?.ok) && response?.status !== "review_pending";
  }

  function feedbackFor(response) {
    if (response?.ok) {
      if (response.status === "downloaded" && response.fallbackCode) {
        return { message: "Lakomics 연결 불가 · 기기에 저장됨", retry: false, kind: "success" };
      }
      const messages = {
        added: "수집 완료",
        duplicate_tagged: "기존 자산에 분류 추가",
        duplicate_unchanged: "이미 저장됨",
        review_pending: "유사 이미지 검토 대기",
        downloaded: "다운로드 완료",
        duplicate_recent: "방금 저장한 미디어입니다",
        metadata_repaired: "JSON 저장 완료",
      };
      return { message: messages[response.status] ?? "저장 완료", retry: false, kind: "success" };
    }
    const errors = {
      app_offline: ["Lakomics를 실행해 주세요", true],
      connection_key_missing: ["확장 프로그램 설정에서 연결 키를 입력해 주세요", false],
      unauthorized: ["확장 프로그램 설정에서 연결 키를 확인해 주세요", false],
      library_not_open: ["Lakomics에서 라이브러리를 열어 주세요", true],
      classification_not_found: ["분류를 새로고침하고 다시 선택해 주세요", false],
      download_failed: ["미디어를 다운로드하지 못했습니다", true],
      metadata_download_failed: ["미디어는 저장됐지만 JSON 저장에 실패했습니다", true],
      video_info_failed: ["X 영상 정보를 가져오지 못했습니다", true],
      video_unavailable: ["이 게시물의 영상을 가져올 수 없습니다", false],
      pc_video_api_unsupported: ["PC Lakomics 앱의 영상 수집 API 업데이트가 필요합니다", false],
      downloads_api_unavailable: ["이 브라우저는 확장 다운로드 API를 지원하지 않습니다", false],
      invalid_media_url: ["미디어 주소를 읽지 못했습니다", false],
      download_too_large: ["미디어가 너무 큽니다", false],
      unsupported_image: ["지원하지 않는 이미지입니다", false],
      request_failed: ["수집 요청에 실패했습니다", true],
      worker_failed: ["확장 프로그램 요청에 실패했습니다", true],
    };
    const [message, retry] = errors[response?.code] ?? ["저장 요청에 실패했습니다", true];
    return { message, retry, kind: "error" };
  }

  const RADIAL_VIEWPORT_EXTENT_PX = 220;
  const RADIAL_VIEWPORT_MARGIN_PX = 8;

  function clampRadialOrigin(origin, viewportWidth, viewportHeight, extent = RADIAL_VIEWPORT_EXTENT_PX, margin = RADIAL_VIEWPORT_MARGIN_PX) {
    const width = Number(viewportWidth);
    const height = Number(viewportHeight);
    if (!origin || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return origin ? { ...origin } : { x: 0, y: 0 };
    }
    const inset = Math.max(0, Number(extent) || 0) + Math.max(0, Number(margin) || 0);
    return {
      x: clampAxis(origin.x, width, inset),
      y: clampAxis(origin.y, height, inset),
    };
  }

  function clampAxis(value, size, inset) {
    if (size <= inset * 2) return size / 2;
    return Math.min(size - inset, Math.max(inset, value));
  }

  function currentViewportSize() {
    const viewport = window.visualViewport;
    return {
      width: viewport?.width ?? window.innerWidth,
      height: viewport?.height ?? window.innerHeight,
    };
  }

  function createClickSuppressor() {
    let armed = false;
    return {
      arm() { armed = true; },
      consume(event) {
        if (!armed) return false;
        armed = false;
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      },
    };
  }

  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsContent = {
      createClickSuppressor,
      createCollectorController,
      feedbackFor,
      isSavedResponse,
      clampRadialOrigin,
    };
    return;
  }

  installContentScript();

  function runtimeMessage(message) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const maybePromise = chrome.runtime.sendMessage(message, (response) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) {
            finish({ ok: false, code: "worker_failed", message: lastError.message });
            return;
          }
          finish(response);
        });
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(finish).catch((error) => {
            finish({ ok: false, code: "worker_failed", message: String(error?.message ?? error ?? "") });
          });
        }
      } catch (error) {
        finish({ ok: false, code: "worker_failed", message: String(error?.message ?? error ?? "") });
      }
    });
  }

  function installContentScript() {
    let pointer = null;
    let menuContext = null;
    let overlay = null;
    let dwellTimer = null;
    let longPressTimer = null;
    let resultToast = null;
    let resultTimer = null;
    let clickShield = null;
    let clickShieldTimer = null;
    let preferences = globalThis.LakomicsDefaults.normalizePreferences();
    const clickSuppressor = createClickSuppressor();
    const controller = createCollectorController({
      send: (payload) => runtimeMessage({ type: "ingestion:create", payload }),
      status: showStatus,
      snapshot: renderSnapshot,
      close: closeRadial,
      saved: (payload, response) => {
        if (payload?.mediaType !== "image" || !payload.mediaUrl) return;
        globalThis.LakomicsXGalleryRuntime?.markSaved?.(payload.mediaUrl, {
          status: response?.status,
          author: payload.author ?? null,
          postId: payload.postId ?? null,
          sourceUrl: payload.sourceUrl ?? null,
        });
      },
    });

    void runtimeMessage({ type: "settings:get" })
      .then((response) => {
        if (response?.ok) preferences = globalThis.LakomicsDefaults.normalizePreferences(response.preferences);
      })
      .catch(() => {});

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerCancel, true);
    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("selectstart", onSelectStart, true);
    document.addEventListener("click", (event) => clickSuppressor.consume(event), true);
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") cancelAll();
    }, true);
    window.addEventListener("blur", () => {
      if (menuContext?.input === "mouse") cancelAll();
    });

    function onPointerDown(event) {
      if (pointer) return;

      if (menuContext?.state === "touch-held") {
        if (!pointerInput(event)) return;
        setTouchGuard(true);
        pointer = {
          id: event.pointerId,
          input: "touch-select",
          latest: pointFromEvent(event),
          latestTime: event.timeStamp,
        };
        event.preventDefault();
        event.stopImmediatePropagation();
        scheduleDwell(controller.move(pointer.latest, pointer.latestTime));
        return;
      }

      const input = pointerInput(event);
      if (!input) return;
      const candidate = globalThis.LakomicsXSource.findCandidate(event.target);
      if (!candidate) return;

      const origin = pointFromEvent(event);
      pointer = {
        id: event.pointerId,
        input,
        candidate,
        origin,
        latest: origin,
        latestTime: event.timeStamp,
        thresholdCrossed: false,
        longPressReady: false,
        started: false,
        classifications: null,
      };

      void loadClassifications(candidate);

      if (input === "touch") {
        setTouchGuard(true);
        longPressTimer = window.setTimeout(() => {
          longPressTimer = null;
          if (!pointer || pointer.candidate !== candidate || pointer.input !== "touch") return;
          pointer.longPressReady = true;
          pointer.thresholdCrossed = true;
          candidate.element.setPointerCapture?.(pointer.id);
          renderLoading(pointer.origin, "분류 불러오는 중…");
          startControllerIfReady(true);
        }, preferences.touchLongPressMs);
      }
    }

    function onPointerMove(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      pointer.latest = pointFromEvent(event);
      pointer.latestTime = event.timeStamp;

      if (pointer.input === "touch-select") {
        event.preventDefault();
        event.stopPropagation();
        scheduleDwell(controller.move(pointer.latest, pointer.latestTime));
        return;
      }

      if (pointer.input === "touch" && !pointer.longPressReady) {
        if (globalThis.LakomicsGesture.distance(pointer.origin, pointer.latest) >= globalThis.LakomicsGesture.TOUCH_CANCEL_DISTANCE_PX) {
          clearLongPressTimer();
          pointer = null;
          setTouchGuard(false);
        }
        return;
      }

      if (pointer.input === "mouse" && !pointer.thresholdCrossed
        && globalThis.LakomicsGesture.distance(pointer.origin, pointer.latest) >= globalThis.LakomicsGesture.OPEN_DISTANCE_PX) {
        pointer.thresholdCrossed = true;
        pointer.candidate.element.setPointerCapture?.(pointer.id);
        renderLoading(pointer.origin, "분류 불러오는 중…");
      }

      if (!pointer.thresholdCrossed) return;
      event.preventDefault();
      event.stopPropagation();
      startControllerIfReady(pointer.input === "touch");
      if (pointer?.started) scheduleDwell(controller.move(pointer.latest, pointer.latestTime));
    }

    function onPointerUp(event) {
      if (!pointer || event.pointerId !== pointer.id) return;

      if (pointer.input === "touch-select") {
        clickSuppressor.arm();
        event.preventDefault();
        event.stopImmediatePropagation();
        pointer = null;
        clearDwellTimer();
        const action = controller.activate();
        if (action.type === "expand" || action.type === "pending") {
          if (menuContext) menuContext.state = "touch-held";
          setTouchGuard(true);
        } else {
          menuContext = null;
          setTouchGuard(false);
          installTouchClickShield();
        }
        return;
      }

      if (pointer.input === "touch" && !pointer.longPressReady) {
        clearLongPressTimer();
        pointer = null;
        setTouchGuard(false);
        return;
      }

      if (!pointer.thresholdCrossed) {
        const wasTouch = pointer.input === "touch";
        pointer = null;
        if (wasTouch) setTouchGuard(false);
        return;
      }

      clickSuppressor.arm();
      event.preventDefault();
      event.stopImmediatePropagation();
      clearLongPressTimer();
      clearDwellTimer();

      if (!pointer.started) {
        showStatus("분류를 불러오지 못했습니다", false, "error");
        cancelAll();
        return;
      }

      if (pointer.input === "touch" && preferences.touchPersistent) {
        pointer = null;
        if (menuContext) menuContext.state = "touch-held";
        return;
      }

      const wasTouch = pointer.input === "touch";
      pointer = null;
      menuContext = null;
      if (wasTouch) {
        setTouchGuard(false);
        installTouchClickShield();
      }
      void controller.release();
    }

    function onPointerCancel(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      if (pointer.input === "touch" && pointer.longPressReady && preferences.touchPersistent && pointer.started) {
        clickSuppressor.arm();
        pointer = null;
        clearLongPressTimer();
        clearDwellTimer();
        if (menuContext) menuContext.state = "touch-held";
        return;
      }
      cancelAll();
    }

    function onContextMenu(event) {
      if (!preferences.suppressContextMenu) return;
      const touchActive = isTouchGestureActive();
      const candidate = globalThis.LakomicsXSource.findCandidate(event.target);
      if (!touchActive && !candidate) return;
      if (touchActive || pointer?.candidate?.element === candidate?.element) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }

    function onSelectStart(event) {
      if (!isTouchGestureActive()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function onDragStart(event) {
      if (globalThis.LakomicsXSource.findCandidate(event.target)) event.preventDefault();
    }

    async function loadClassifications(candidate) {
      const response = await runtimeMessage({ type: "classifications:get" });
      if (!pointer || pointer.candidate !== candidate) return;
      if (!response.ok) {
        if (pointer.thresholdCrossed || pointer.longPressReady) showStatus(feedbackFor(response).message, false, "error");
        cancelAll();
        return;
      }
      pointer.classifications = response;
      startControllerIfReady(pointer.input === "touch");
    }

    function startControllerIfReady(openImmediately = false) {
      if (!pointer || pointer.started || !pointer.thresholdCrossed || !pointer.classifications) return;
      pointer.started = true;
      const radialOrigin = pointer.input === "touch"
        ? clampRadialOrigin(pointer.origin, currentViewportSize().width, currentViewportSize().height)
        : { ...pointer.origin };
      menuContext = {
        input: pointer.input === "touch" ? "touch" : "mouse",
        state: pointer.input === "touch" ? "touch-active" : "mouse-active",
        origin: radialOrigin,
        candidate: pointer.candidate,
      };
      const first = controller.begin(
        pointer.candidate,
        radialOrigin,
        pointer.classifications.entries,
        pointer.classifications.layout,
        pointer.classifications.pinnedIds,
        pointer.classifications.classificationSource ?? "app",
        {
          openImmediately,
          centerSelectsExpandedParent: pointer.input === "touch",
          confirmSelectionWithCenter: pointer.input === "touch",
        },
      );
      if (openImmediately) {
        renderSnapshot(first);
        // A touch menu may be shifted away from the press point to stay fully
        // inside the viewport. Start it at its visual center so opening near
        // an edge does not accidentally hover/expand a sector.
        scheduleDwell(controller.move(radialOrigin, pointer.latestTime));
      } else {
        scheduleDwell(controller.move(pointer.latest, pointer.latestTime));
      }
    }

    function scheduleDwell(snapshot) {
      clearDwellTimer();
      if (!snapshot?.opened || snapshot.dwellDeadline === null || !pointer) return;
      const currentPointerId = pointer.id;
      const latestTime = pointer.latestTime;
      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        if (!pointer || pointer.id !== currentPointerId) return;
        const next = controller.tick(snapshot.dwellDeadline);
        scheduleDwell(next);
      }, Math.max(0, snapshot.dwellDeadline - latestTime));
    }

    function clearDwellTimer() {
      if (dwellTimer !== null) window.clearTimeout(dwellTimer);
      dwellTimer = null;
    }

    function clearLongPressTimer() {
      if (longPressTimer !== null) window.clearTimeout(longPressTimer);
      longPressTimer = null;
    }

    function cancelAll() {
      if (pointer?.thresholdCrossed || menuContext) clickSuppressor.arm();
      pointer = null;
      menuContext = null;
      setTouchGuard(false);
      clearLongPressTimer();
      clearDwellTimer();
      controller.cancel();
    }

    function isTouchGestureActive() {
      return pointer?.input === "touch"
        || pointer?.input === "touch-select"
        || menuContext?.input === "touch";
    }

    function setTouchGuard(active) {
      document.documentElement.classList.toggle("lakomics-touch-gesture-active", Boolean(active));
    }

    function installTouchClickShield() {
      if (clickShieldTimer !== null) window.clearTimeout(clickShieldTimer);
      clickShield?.remove();
      clickShield = document.createElement("div");
      clickShield.className = "lakomics-touch-click-shield";
      clickShield.setAttribute("aria-hidden", "true");
      const block = (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      clickShield.addEventListener("pointerdown", block, true);
      clickShield.addEventListener("pointerup", block, true);
      clickShield.addEventListener("click", block, true);
      document.documentElement.append(clickShield);
      clickShieldTimer = window.setTimeout(() => {
        clickShield?.remove();
        clickShield = null;
        clickShieldTimer = null;
      }, 420);
    }

    function renderLoading(origin, label) {
      closeRadial();
      overlay = document.createElement("div");
      overlay.className = "lakomics-radial-overlay";
      const loading = document.createElement("div");
      loading.className = "lakomics-radial-loading";
      loading.style.left = `${origin.x}px`;
      loading.style.top = `${origin.y}px`;
      loading.textContent = label;
      overlay.append(loading);
      document.documentElement.append(overlay);
    }

    function renderSnapshot(snapshot) {
      if (!menuContext || !snapshot?.opened) return;
      closeRadial();
      overlay = document.createElement("div");
      overlay.className = `lakomics-radial-overlay${menuContext.input === "touch" ? " is-touch" : ""}`;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "-220 -220 440 440");
      svg.style.left = `${menuContext.origin.x}px`;
      svg.style.top = `${menuContext.origin.y}px`;
      svg.classList.add("lakomics-radial-menu");
      renderPrimarySectors(svg, snapshot);
      if (snapshot.secondaryLevel) renderSecondarySectors(svg, snapshot);
      renderCenter(svg, snapshot);
      renderControls(svg, snapshot);
      overlay.append(svg);
      document.documentElement.append(overlay);
    }

    function renderPrimarySectors(svg, snapshot) {
      const count = snapshot.primaryLevel.slotCount;
      snapshot.primaryLevel.slots.forEach((entry, index) => {
        const start = -Math.PI / 2 + (Math.PI * 2 * (index - 0.5)) / count;
        const end = -Math.PI / 2 + (Math.PI * 2 * (index + 0.5)) / count;
        const path = svgElement("path", {
          d: sectorPath(48, 110, start, end),
          class: `lakomics-sector${snapshot.hover?.type === "primary-slot" && snapshot.hover.index === index ? " is-active" : ""}${entry ? "" : " is-empty"}${snapshot.expandedParentId === entry?.id ? " is-expanded" : ""}${snapshot.pendingClassificationId === entry?.id ? " is-selected" : ""}`,
        });
        svg.append(path);
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
        const text = svgElement("text", {
          x: Math.cos(angle) * 79,
          y: Math.sin(angle) * 79,
          class: "lakomics-sector-label",
        });
        text.textContent = entry?.name ?? "";
        svg.append(text);
      });
    }

    function renderSecondarySectors(svg, snapshot) {
      const angles = snapshot.secondaryAngles;
      if (!angles) return;
      snapshot.secondaryLevel.slots.forEach((entry, index) => {
        const angle = angles[index];
        if (!angle) return;
        const path = svgElement("path", {
          d: sectorPath(130, 185, angle.start, angle.end),
          class: `lakomics-sector-secondary${snapshot.hover?.type === "secondary-slot" && snapshot.hover.index === index ? " is-active" : ""}${entry ? "" : " is-empty"}${snapshot.pendingClassificationId === entry?.id ? " is-selected" : ""}`,
        });
        svg.append(path);
        const text = svgElement("text", {
          x: Math.cos(angle.center) * 157,
          y: Math.sin(angle.center) * 157,
          class: "lakomics-sector-label-secondary",
        });
        text.textContent = entry?.name ?? "";
        svg.append(text);
      });
    }

    function renderCenter(svg, snapshot) {
      const circle = svgElement("circle", {
        cx: 0,
        cy: 0,
        r: 42,
        class: `lakomics-radial-center${snapshot.hover?.type === "center" ? " is-active" : ""}`,
      });
      const label = svgElement("text", { x: 0, y: 4, class: "lakomics-center-label" });
      const parentEntry = snapshot.primaryLevel.slots.find((entry) => entry?.id === snapshot.expandedParentId);
      if (menuContext?.input === "touch") {
        label.textContent = snapshot.pendingClassificationId || snapshot.expandedParentId ? "저장" : "취소";
      } else {
        label.textContent = parentEntry?.name ?? "취소";
      }
      svg.append(circle, label);
    }

    function renderControls(svg, snapshot) {
      const activePage = snapshot.secondaryLevel ? snapshot.secondaryPage : snapshot.primaryPage;
      const activePageCount = snapshot.secondaryLevel ? snapshot.secondaryLevel.pageCount : snapshot.primaryLevel.pageCount;
      if (activePage > 0) renderControl(svg, -195, 0, "‹", snapshot.hover?.type === "previous");
      if (activePage + 1 < activePageCount) renderControl(svg, 195, 0, "›", snapshot.hover?.type === "next");
    }

    function renderControl(svg, x, y, label, active) {
      const group = svgElement("g", { class: `lakomics-radial-control${active ? " is-active" : ""}` });
      group.append(
        svgElement("circle", { cx: x, cy: y, r: 28 }),
        svgElement("text", { x, y: y + 4, class: "lakomics-control-label" }),
      );
      group.lastChild.textContent = label;
      svg.append(group);
    }

    function showStatus(message, retry, kind = "progress") {
      if (resultToast) resultToast.remove();
      if (resultTimer !== null) window.clearTimeout(resultTimer);
      resultTimer = null;
      resultToast = document.createElement("div");
      resultToast.className = `lakomics-result-toast is-${kind}`;
      if (kind === "error") {
        resultToast.setAttribute("role", "alert");
        resultToast.setAttribute("aria-live", "assertive");
        const icon = document.createElement("span");
        icon.className = "lakomics-result-toast-icon";
        icon.textContent = "!";
        icon.setAttribute("aria-hidden", "true");
        resultToast.append(icon);
      }
      const text = document.createElement("span");
      text.className = "lakomics-result-toast-text";
      text.textContent = message;
      resultToast.append(text);
      if (retry) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "다시 시도";
        button.addEventListener("click", () => void controller.retry());
        resultToast.append(button);
      }
      const timeoutMs = kind === "error" ? 8_000 : 3_000;
      resultTimer = window.setTimeout(() => {
        resultToast?.remove();
        resultToast = null;
        resultTimer = null;
      }, timeoutMs);
      document.documentElement.append(resultToast);
    }

    function closeRadial() {
      overlay?.remove();
      overlay = null;
    }
  }

  function pointerInput(event) {
    if (event.pointerType === "mouse") return event.button === 0 ? "mouse" : null;
    if (event.pointerType === "touch" || event.pointerType === "pen") return "touch";
    return null;
  }

  function pointFromEvent(event) {
    return { x: event.clientX, y: event.clientY };
  }

  function sectorPath(innerRadius, outerRadius, start, end) {
    const outerStart = point(outerRadius, start);
    const outerEnd = point(outerRadius, end);
    const innerEnd = point(innerRadius, end);
    const innerStart = point(innerRadius, start);
    const largeArc = end - start > Math.PI ? 1 : 0;
    return [
      `M ${outerStart.x} ${outerStart.y}`,
      `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
      `L ${innerEnd.x} ${innerEnd.y}`,
      `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
      "Z",
    ].join(" ");
  }

  function point(radius, angle) {
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
  }

  function svgElement(name, attributes) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    return element;
  }
})();
