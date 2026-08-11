(() => {
  "use strict";

  function createCollectorController({ send, status, snapshot = () => {}, close = () => {} }) {
    let active = null;
    let failedPayload = null;

    function begin(candidate, origin, entries, layout) {
      active = {
        candidate,
        session: globalThis.LakomicsGesture.createSession(origin, entries, layout),
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
      active = null;
      close();
      const action = current.session.release();
      if (action.type !== "select") return action;
      const payload = {
        source: "x",
        mediaUrl: current.candidate.mediaUrl,
        sourceUrl: current.candidate.sourceUrl,
        classificationId: action.classificationId,
      };
      return submit(payload);
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
      status("Lakomics로 수집 중", false);
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
      status(feedback.message, feedback.retry);
      return response;
    }

    return { begin, move, tick, release, cancel, retry };
  }

  function feedbackFor(response) {
    if (response?.ok) {
      const messages = {
        added: "수집 완료",
        duplicate_tagged: "기존 자산에 분류 추가",
        duplicate_unchanged: "이미 저장됨",
        review_pending: "유사 이미지 검토 대기",
      };
      return { message: messages[response.status] ?? "수집 완료", retry: false };
    }
    const errors = {
      app_offline: ["Lakomics를 실행해 주세요", true],
      connection_key_missing: ["확장 프로그램 설정에서 연결 키를 입력해 주세요", false],
      unauthorized: ["확장 프로그램 설정에서 연결 키를 확인해 주세요", false],
      library_not_open: ["Lakomics에서 라이브러리를 열어 주세요", true],
      classification_not_found: ["분류를 새로고침하고 다시 선택해 주세요", false],
      download_failed: ["이미지를 다운로드하지 못했습니다", true],
      download_too_large: ["이미지가 너무 큽니다", false],
      unsupported_image: ["지원하지 않는 이미지입니다", false],
      request_failed: ["수집 요청에 실패했습니다", true],
      worker_failed: ["확장 프로그램 요청에 실패했습니다", true],
    };
    const [message, retry] = errors[response?.code] ?? ["수집 요청에 실패했습니다", true];
    return { message, retry };
  }

  if (globalThis.__LAKOMICS_TEST__) {
    globalThis.LakomicsContent = { createCollectorController, feedbackFor };
    return;
  }

  installContentScript();

  function installContentScript() {
    let pointer = null;
    let overlay = null;
    let dwellTimer = null;
    let resultToast = null;
    let resultTimer = null;
    let resultAnchor = null;
    const controller = createCollectorController({
      send: (payload) => chrome.runtime.sendMessage({ type: "ingestion:create", payload }),
      status: showStatus,
      snapshot: renderSnapshot,
      close: closeRadial,
    });

    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", cancelPointer, true);
    document.addEventListener("dragstart", onDragStart, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") cancelPointer();
    }, true);
    window.addEventListener("blur", cancelPointer);

    function onPointerDown(event) {
      if (pointer || event.button !== 0 || event.pointerType !== "mouse") return;
      const candidate = globalThis.LakomicsXSource.findCandidate(event.target);
      if (!candidate) return;
      pointer = {
        id: event.pointerId,
        candidate,
        origin: { x: event.clientX, y: event.clientY },
        latest: { x: event.clientX, y: event.clientY },
        latestTime: event.timeStamp,
        thresholdCrossed: false,
        started: false,
        classifications: null,
      };
      resultAnchor = candidate.image;
      void chrome.runtime.sendMessage({ type: "classifications:get" })
        .catch(() => ({ ok: false, code: "worker_failed" }))
        .then((response) => {
          if (!pointer || pointer.candidate !== candidate) return;
          if (!response.ok) {
            if (pointer.thresholdCrossed) showStatus(feedbackFor(response).message, false);
            cancelPointer();
            return;
          }
          pointer.classifications = response;
          startControllerIfReady();
        });
    }

    function onPointerMove(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      pointer.latest = { x: event.clientX, y: event.clientY };
      pointer.latestTime = event.timeStamp;
      if (!pointer.thresholdCrossed
        && globalThis.LakomicsGesture.distance(pointer.origin, pointer.latest) >= globalThis.LakomicsGesture.OPEN_DISTANCE_PX) {
        pointer.thresholdCrossed = true;
        pointer.candidate.image.setPointerCapture?.(pointer.id);
        renderLoading(pointer.origin);
      }
      if (!pointer.thresholdCrossed) return;
      event.preventDefault();
      event.stopPropagation();
      startControllerIfReady();
      if (pointer.started) scheduleDwell(controller.move(pointer.latest, pointer.latestTime));
    }

    function onPointerUp(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      if (!pointer.thresholdCrossed) {
        pointer = null;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!pointer.started) {
        showStatus("분류를 불러오지 못했습니다", false);
        cancelPointer();
        return;
      }
      pointer = null;
      clearDwellTimer();
      void controller.release();
    }

    function onDragStart(event) {
      if (globalThis.LakomicsXSource.findCandidate(event.target)) event.preventDefault();
    }

    function cancelPointer() {
      if (!pointer) return;
      pointer = null;
      clearDwellTimer();
      controller.cancel();
    }

    function startControllerIfReady() {
      if (!pointer || pointer.started || !pointer.thresholdCrossed || !pointer.classifications) return;
      pointer.started = true;
      controller.begin(
        pointer.candidate,
        pointer.origin,
        pointer.classifications.entries,
        pointer.classifications.layout,
      );
      scheduleDwell(controller.move(pointer.latest, pointer.latestTime));
    }

    function scheduleDwell(snapshot) {
      clearDwellTimer();
      if (!snapshot?.opened || snapshot.dwellDeadline === null) return;
      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        const next = controller.tick(snapshot.dwellDeadline);
        scheduleDwell(next);
      }, Math.max(0, snapshot.dwellDeadline - pointer.latestTime));
    }

    function clearDwellTimer() {
      if (dwellTimer !== null) window.clearTimeout(dwellTimer);
      dwellTimer = null;
    }

    function renderLoading(origin) {
      closeRadial();
      overlay = document.createElement("div");
      overlay.className = "lakomics-radial-overlay";
      const loading = document.createElement("div");
      loading.className = "lakomics-radial-loading";
      loading.style.left = `${origin.x}px`;
      loading.style.top = `${origin.y}px`;
      loading.textContent = "분류 불러오는 중…";
      overlay.append(loading);
      document.documentElement.append(overlay);
    }

    function renderSnapshot(snapshot) {
      if (!pointer || !snapshot?.opened) return;
      closeRadial();
      overlay = document.createElement("div");
      overlay.className = "lakomics-radial-overlay";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "-200 -200 400 400");
      svg.style.left = `${pointer.origin.x}px`;
      svg.style.top = `${pointer.origin.y}px`;
      svg.classList.add("lakomics-radial-menu");
      renderSectors(svg, snapshot);
      renderCenter(svg, snapshot);
      renderControls(svg, snapshot);
      overlay.append(svg);
      document.documentElement.append(overlay);
    }

    function renderSectors(svg, snapshot) {
      const count = snapshot.level.slotCount;
      snapshot.level.slots.forEach((entry, index) => {
        const start = -Math.PI / 2 + (Math.PI * 2 * (index - 0.5)) / count;
        const end = -Math.PI / 2 + (Math.PI * 2 * (index + 0.5)) / count;
        const path = svgElement("path", {
          d: sectorPath(48, 132, start, end),
          class: `lakomics-sector${snapshot.hover?.type === "slot" && snapshot.hover.index === index ? " is-active" : ""}${entry ? "" : " is-empty"}`,
        });
        svg.append(path);
        const angle = -Math.PI / 2 + (Math.PI * 2 * index) / count;
        const text = svgElement("text", {
          x: Math.cos(angle) * 91,
          y: Math.sin(angle) * 91,
          class: "lakomics-sector-label",
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
      label.textContent = snapshot.path.at(-1)?.name ?? "취소";
      svg.append(circle, label);
    }

    function renderControls(svg, snapshot) {
      if (snapshot.level.page > 0) renderControl(svg, -166, 0, "‹", snapshot.hover?.type === "previous");
      if (snapshot.level.page + 1 < snapshot.level.pageCount) renderControl(svg, 166, 0, "›", snapshot.hover?.type === "next");
      if (snapshot.path.length) renderControl(svg, 0, 166, "위로", snapshot.hover?.type === "back");
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

    function showStatus(message, retry) {
      if (resultToast) resultToast.remove();
      if (resultTimer !== null) window.clearTimeout(resultTimer);
      resultToast = document.createElement("div");
      resultToast.className = "lakomics-result-toast";
      const rect = resultAnchor?.getBoundingClientRect?.();
      resultToast.style.left = `${Math.max(12, rect?.left ?? 12)}px`;
      resultToast.style.top = `${Math.max(12, (rect?.top ?? 12) + 12)}px`;
      const text = document.createElement("span");
      text.textContent = message;
      resultToast.append(text);
      if (retry) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "다시 시도";
        button.addEventListener("click", () => void controller.retry());
        resultToast.append(button);
      } else {
        resultTimer = window.setTimeout(() => {
          resultToast?.remove();
          resultToast = null;
          resultTimer = null;
        }, 3_000);
      }
      document.documentElement.append(resultToast);
    }

    function closeRadial() {
      overlay?.remove();
      overlay = null;
    }
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
