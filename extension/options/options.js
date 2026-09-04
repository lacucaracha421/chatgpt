(() => {
  "use strict";

  const saveModeSelect = document.querySelector("#save-mode");
  const savePolicyNote = document.querySelector("#save-policy-note");
  const saveModeStatus = document.querySelector("#save-mode-status");
  const diagnosticsSummary = document.querySelector("#diagnostics-summary");
  const refreshDiagnostics = document.querySelector("#refresh-diagnostics");
  const diagnosticsStatus = document.querySelector("#diagnostics-status");
  const tokenInput = document.querySelector("#connection-token");
  const collectorEnabled = document.querySelector("#collector-enabled");
  const collectorBaseUrl = document.querySelector("#collector-base-url");
  const collectorToken = document.querySelector("#collector-token");
  const saveTestCollector = document.querySelector("#save-test-collector");
  const collectorStatus = document.querySelector("#collector-status");
  const downloadFolder = document.querySelector("#download-folder");
  const touchLongPress = document.querySelector("#touch-long-press");
  const suppressDownloadUi = document.querySelector("#suppress-download-ui");
  const autoLikeOnSave = document.querySelector("#auto-like-on-save");
  const savePreferences = document.querySelector("#save-preferences");
  const preferencesStatus = document.querySelector("#preferences-status");
  const xTranslateEnabled = document.querySelector("#x-translate-enabled");
  const xTranslateStatus = document.querySelector("#x-translate-status");
  const refreshButton = document.querySelector("#refresh-classifications");
  const status = document.querySelector("#connection-status");
  const editor = document.querySelector("#layout-editor");
  const remoteEnabled = document.querySelector("#remote-enabled");
  const remoteBaseUrl = document.querySelector("#remote-base-url");
  const saveTestRemote = document.querySelector("#save-test-remote");
  const remoteStatus = document.querySelector("#remote-status");
  const connectionBackupJson = document.querySelector("#connection-backup-json");
  const exportConnectionBackup = document.querySelector("#export-connection-backup");
  const importConnectionBackup = document.querySelector("#import-connection-backup");
  const connectionBackupStatus = document.querySelector("#connection-backup-status");
  const localPrimarySelect = document.querySelector("#local-primary-select");
  const localPrimaryName = document.querySelector("#local-primary-name");
  const localSecondaryGrid = document.querySelector("#local-secondary-grid");
  const saveLocalTree = document.querySelector("#save-local-tree");
  const resetLocalTree = document.querySelector("#reset-local-tree");
  const copyAppTree = document.querySelector("#copy-app-tree");
  const exportLocalTree = document.querySelector("#export-local-tree");
  const importLocalTree = document.querySelector("#import-local-tree");
  const localTreeJson = document.querySelector("#local-tree-json");
  const localTreeStatus = document.querySelector("#local-tree-status");
  const mobileSiteAccess = document.querySelector("#mobile-site-access");
  const requestMobileSiteAccess = document.querySelector("#request-mobile-site-access");
  const mobileSiteAccessResult = document.querySelector("#mobile-site-access-result");
  const mobileSiteAccessDiagnostic = document.querySelector("#mobile-site-access-diagnostic");
  let entries = [];
  let workingLayout = { version: 1, parents: {} };
  let path = [];
  let page = 0;
  let selectedIndex = null;
  let pinnedIds = [];
  let pinnedPersistQueue = Promise.resolve();
  let secondaryUsageById = {};
  let hiddenSecondaryIds = [];
  let localTree = null;
  let localPrimaryIndex = 0;
  let localSecondaryInputs = [];

  void initialize();
  void refreshMobileAccessStatus();

  function renderMobileAccessState(result, afterRequest = false) {
    const state = result?.state || "error";
    if (state === "granted") {
      mobileSiteAccess.textContent = "접근 허용됨";
      mobileSiteAccessResult.textContent = afterRequest
        ? "Mobile Lakomics 사이트 접근 권한이 허용되었습니다."
        : "";
      mobileSiteAccessDiagnostic.textContent = "이 상태인데 Mobile 페이지가 확장을 감지하지 못하면 Titanium 콘텐츠 스크립트 호환 문제입니다. 확장은 감지되지만 라이브러리가 열리지 않으면 서비스 워커/API 상태를 확인하세요.";
      return;
    }
    if (state === "needed") {
      mobileSiteAccess.textContent = "접근 권한 필요";
      mobileSiteAccessResult.textContent = afterRequest ? "사이트 접근 권한이 허용되지 않았습니다." : "";
      mobileSiteAccessDiagnostic.textContent = "브라우저가 Mobile Lakomics 사이트의 확장 접근 권한을 보류 중입니다.";
      return;
    }
    mobileSiteAccess.textContent = "권한 상태 확인 실패";
    mobileSiteAccessResult.textContent = afterRequest
      ? "이 브라우저에서는 사이트 권한 요청을 처리하지 못했습니다."
      : "";
    mobileSiteAccessDiagnostic.textContent = "이 브라우저에서 사이트 권한 API 상태를 확인할 수 없습니다.";
  }

  async function refreshMobileAccessStatus() {
    const helper = globalThis.LakomicsMobileAccess;
    if (!helper) {
      renderMobileAccessState({ state: "error" });
      return;
    }
    renderMobileAccessState(await helper.checkMobileAccess(chrome.permissions));
  }

  requestMobileSiteAccess.addEventListener("click", async () => {
    mobileSiteAccessResult.textContent = "사이트 접근 권한을 확인하는 중…";
    const helper = globalThis.LakomicsMobileAccess;
    if (!helper) {
      renderMobileAccessState({ state: "error" }, true);
      return;
    }
    const result = await helper.requestMobileAccess(chrome.permissions);
    renderMobileAccessState(result, true);
  });

  async function initialize() {
    const settings = await chrome.runtime.sendMessage({ type: "settings:get" });
    status.textContent = settings.tokenConfigured ? "연결 키가 저장되어 있습니다." : "Lakomics에서 연결 키를 복사해 입력하세요.";
    if (settings.lastConnectionFailure) {
      const when = new Date(settings.lastConnectionFailure.failedAt).toLocaleString();
      status.textContent += ` · 마지막 실패: ${when} (${describeErrorCode(settings.lastConnectionFailure.code)})`;
    }
    const preferences = settings.preferences ?? {};
    const remote = settings.remote ?? {};
    const collector = settings.collector ?? {};
    collectorEnabled.checked = collector.enabled === true;
    collectorBaseUrl.value = collector.baseUrl ?? "";
    collectorStatus.textContent = settings.collectorTokenConfigured
      ? (collector.enabled ? "Cloud 토큰이 저장되어 있습니다." : "Cloud 토큰이 저장되어 있습니다. Cloud Capture는 꺼져 있습니다.")
      : "Cloud API 토큰을 입력하세요.";
    remoteEnabled.checked = remote.enabled === true;
    remoteBaseUrl.value = remote.baseUrl ?? "";
    saveModeSelect.value = preferences.saveMode ?? "auto";
    describeSavePolicy(saveModeSelect.value);
    downloadFolder.value = preferences.downloadFolder ?? "Lakomics";
    touchLongPress.value = String(preferences.touchLongPressMs ?? 450);
    suppressDownloadUi.checked = preferences.suppressDownloadUi === true;
    autoLikeOnSave.checked = preferences.autoLikeOnSave !== false;
    preferencesStatus.textContent = settings.downloadsApiAvailable
      ? (settings.downloadsUiApiAvailable ? "모바일 다운로드 UI 제어 사용 가능" : "다운로드 UI 숨김 API를 찾지 못했습니다.")
      : "확장 다운로드 API를 찾지 못했습니다.";
    renderDiagnostics(settings);
    const translateStored = await chrome.storage.local.get(["xTranslateEnabled"]);
    xTranslateEnabled.checked = translateStored.xTranslateEnabled !== false;
    xTranslateStatus.textContent = xTranslateEnabled.checked
      ? "활성화됨 · X에서 訳 버튼으로 설정할 수 있습니다."
      : "꺼져 있습니다.";
    const stored = await chrome.runtime.sendMessage({ type: "layout:get" });
    if (stored.ok) workingLayout = stored.layout;
    const pinned = await chrome.runtime.sendMessage({ type: "pinned:get" });
    if (pinned.ok) pinnedIds = pinned.pinnedIds;
    const presentation = await chrome.runtime.sendMessage({ type: "secondary-presentation:get" });
    if (presentation.ok) {
      secondaryUsageById = presentation.usage ?? {};
      hiddenSecondaryIds = presentation.hiddenIds ?? [];
    }
    const local = await chrome.runtime.sendMessage({ type: "local-tree:get" });
    if (local.ok) {
      localTree = local.tree;
      renderLocalTreeEditor();
    }
  }



  saveModeSelect.addEventListener("change", async () => {
    const mode = saveModeSelect.value;
    saveModeStatus.textContent = "저장 방식을 저장하는 중…";
    const response = await chrome.runtime.sendMessage({
      type: "settings:set-preferences",
      preferences: { saveMode: mode },
    });
    if (!response.ok) {
      saveModeStatus.textContent = errorMessage(response.code);
      return;
    }
    saveModeSelect.value = response.preferences.saveMode;
    describeSavePolicy(response.preferences.saveMode);
    saveModeStatus.textContent = "저장 방식을 변경했습니다.";
  });

  refreshDiagnostics.addEventListener("click", async () => {
    diagnosticsStatus.textContent = "상태를 다시 읽는 중…";
    const settings = await chrome.runtime.sendMessage({ type: "settings:get" });
    renderDiagnostics(settings);
    diagnosticsStatus.textContent = "";
  });

  xTranslateEnabled.addEventListener("change", async () => {
    await chrome.storage.local.set({ xTranslateEnabled: xTranslateEnabled.checked });
    xTranslateStatus.textContent = xTranslateEnabled.checked
      ? "X Translate를 켰습니다. 열려 있는 X 탭을 새로고침하면 적용됩니다."
      : "X Translate를 껐습니다. 열려 있는 X 탭을 새로고침하면 사라집니다.";
  });

  saveTestCollector.addEventListener("click", async () => {
    collectorStatus.textContent = "미디어 저장 서버 설정을 저장하는 중…";
    const typedToken = collectorToken.value.trim();
    if (typedToken) {
      const tokenResponse = await chrome.runtime.sendMessage({ type: "settings:set-collector-token", token: typedToken });
      if (!tokenResponse.ok) { collectorStatus.textContent = errorMessage(tokenResponse.code); return; }
      collectorToken.value = "";
    }
    const saved = await chrome.runtime.sendMessage({
      type: "settings:set-collector",
      collector: { enabled: collectorEnabled.checked, baseUrl: collectorBaseUrl.value },
    });
    if (!saved.ok) { collectorStatus.textContent = errorMessage(saved.code); return; }
    collectorEnabled.checked = saved.collector.enabled;
    collectorBaseUrl.value = saved.collector.baseUrl;
    if (!saved.collector.enabled) {
      collectorStatus.textContent = "서버 저장을 껐습니다. 기존 PC/기기 저장 경로를 사용합니다.";
      return;
    }
    collectorStatus.textContent = "VPS Capture Inbox에 연결하는 중…";
    const tested = await chrome.runtime.sendMessage({ type: "collector:test" });
    collectorStatus.textContent = tested.ok ? "서버 연결 성공 · 미디어 저장 준비 완료" : errorMessage(tested.code);
  });

  saveTestRemote.addEventListener("click", async () => {
    remoteStatus.textContent = "원격 연결 설정을 저장하는 중…";
    const typedToken = tokenInput.value.trim();
    if (typedToken) {
      const tokenResponse = await chrome.runtime.sendMessage({ type: "settings:set-token", token: typedToken });
      if (!tokenResponse.ok) {
        remoteStatus.textContent = errorMessage(tokenResponse.code);
        return;
      }
      tokenInput.value = "";
    }
    const saved = await chrome.runtime.sendMessage({
      type: "settings:set-remote",
      remote: { enabled: remoteEnabled.checked, baseUrl: remoteBaseUrl.value },
    });
    if (!saved.ok) {
      remoteStatus.textContent = errorMessage(saved.code);
      return;
    }
    remoteEnabled.checked = saved.remote.enabled;
    remoteBaseUrl.value = saved.remote.baseUrl;
    if (!saved.remote.enabled) {
      remoteStatus.textContent = "원격 연결을 껐습니다. 이 기기는 localhost 또는 모바일 로컬 모드를 사용합니다.";
      return;
    }
    remoteStatus.textContent = "PC Lakomics에 연결하는 중…";
    const tested = await chrome.runtime.sendMessage({ type: "remote:test" });
    if (!tested.ok) {
      remoteStatus.textContent = errorMessage(tested.code);
      return;
    }
    const version = tested.health?.apiVersion ? ` · API v${tested.health.apiVersion}` : "";
    remoteStatus.textContent = tested.legacyHealth
      ? `원격 연결 성공${version} · 기존 API 호환 모드`
      : `원격 연결 성공${version}`;
  });

  exportConnectionBackup.addEventListener("click", async () => {
    connectionBackupStatus.textContent = "연결 설정을 내보내는 중…";
    const response = await chrome.runtime.sendMessage({ type: "connection-backup:export" });
    if (!response.ok) {
      connectionBackupStatus.textContent = errorMessage(response.code);
      return;
    }
    connectionBackupJson.value = JSON.stringify(response.backup, null, 2);
    try {
      await navigator.clipboard.writeText(connectionBackupJson.value);
      connectionBackupStatus.textContent = "연결 설정 JSON을 내보내고 클립보드에도 복사했습니다. 이 JSON은 비밀로 보관하세요.";
    } catch {
      connectionBackupStatus.textContent = "연결 설정 JSON을 내보냈습니다. 이 JSON은 비밀로 보관하세요.";
    }
  });

  importConnectionBackup.addEventListener("click", async () => {
    let backup;
    try {
      backup = JSON.parse(connectionBackupJson.value);
    } catch {
      connectionBackupStatus.textContent = "연결 설정 JSON 형식이 올바르지 않습니다.";
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: "connection-backup:import", backup });
    if (!response.ok) {
      connectionBackupStatus.textContent = errorMessage(response.code);
      return;
    }
    remoteEnabled.checked = response.remote.enabled;
    remoteBaseUrl.value = response.remote.baseUrl;
    tokenInput.value = "";
    status.textContent = "연결 키가 복원되었습니다.";
    connectionBackupStatus.textContent = "연결 키와 Remote 주소를 복원했습니다. 원격 연결 테스트를 실행하면 바로 확인할 수 있습니다.";
  });

  localPrimarySelect.addEventListener("change", () => {
    commitLocalEditor();
    localPrimaryIndex = Math.max(0, Number(localPrimarySelect.value) || 0);
    renderLocalTreeEditor();
  });

  localPrimaryName.addEventListener("input", () => {
    if (!localTree) return;
    localTree.roots[localPrimaryIndex].name = localPrimaryName.value;
    refreshLocalPrimaryOptions();
  });

  saveLocalTree.addEventListener("click", async () => {
    commitLocalEditor();
    const response = await chrome.runtime.sendMessage({ type: "local-tree:set", tree: localTree });
    if (!response.ok) {
      localTreeStatus.textContent = "모바일 도넛을 저장하지 못했습니다.";
      return;
    }
    localTree = response.tree;
    renderLocalTreeEditor();
    localTreeStatus.textContent = "모바일 도넛을 저장했습니다. 열려 있는 X 탭은 새로고침하면 반영됩니다.";
  });

  resetLocalTree.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: "local-tree:reset" });
    if (!response.ok) {
      localTreeStatus.textContent = "모바일 도넛을 초기화하지 못했습니다.";
      return;
    }
    localTree = response.tree;
    localPrimaryIndex = 0;
    renderLocalTreeEditor();
    localTreeStatus.textContent = "모바일 도넛을 기본 6개 1차 분류와 빈 2차 슬롯으로 초기화했습니다.";
  });

  copyAppTree.addEventListener("click", async () => {
    localTreeStatus.textContent = "현재 PC 도넛을 읽는 중…";
    const response = await chrome.runtime.sendMessage({ type: "local-tree:copy-app" });
    if (!response.ok) {
      localTreeStatus.textContent = errorMessage(response.code);
      return;
    }
    localTree = response.tree;
    localPrimaryIndex = 0;
    renderLocalTreeEditor();
    localTreeStatus.textContent = "현재 연결된 Lakomics 분류를 모바일 도넛으로 복사했습니다.";
  });

  exportLocalTree.addEventListener("click", async () => {
    commitLocalEditor();
    localTreeJson.value = JSON.stringify(localTree, null, 2);
    try {
      await navigator.clipboard.writeText(localTreeJson.value);
      localTreeStatus.textContent = "모바일 도넛 JSON을 아래에 내보내고 클립보드에도 복사했습니다.";
    } catch {
      localTreeStatus.textContent = "모바일 도넛 JSON을 아래에 내보냈습니다.";
    }
  });

  importLocalTree.addEventListener("click", async () => {
    let parsed;
    try {
      parsed = JSON.parse(localTreeJson.value);
    } catch {
      localTreeStatus.textContent = "JSON 형식이 올바르지 않습니다.";
      return;
    }
    const response = await chrome.runtime.sendMessage({ type: "local-tree:set", tree: parsed });
    if (!response.ok) {
      localTreeStatus.textContent = "모바일 도넛 JSON을 가져오지 못했습니다.";
      return;
    }
    localTree = response.tree;
    localPrimaryIndex = 0;
    renderLocalTreeEditor();
    localTreeStatus.textContent = "모바일 도넛 JSON을 가져와 저장했습니다.";
  });

  savePreferences.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "settings:set-preferences",
      preferences: {
        saveMode: "auto",
        downloadFolder: downloadFolder.value,
        touchLongPressMs: Number(touchLongPress.value),
        touchPersistent: true,
        suppressContextMenu: true,
        suppressDownloadUi: suppressDownloadUi.checked,
        autoLikeOnSave: autoLikeOnSave.checked,
      },
    });
    if (!response.ok) {
      preferencesStatus.textContent = response.code === "absolute_download_path_unsupported"
        ? "절대 경로는 지정할 수 없습니다. Download 아래의 폴더 이름만 입력하세요."
        : "일반 설정을 저장하지 못했습니다.";
      return;
    }
    if (suppressDownloadUi.checked && response.downloadUiControl?.ok === false) {
      preferencesStatus.textContent = "설정은 저장했지만 이 브라우저에서 다운로드 UI 숨김을 적용하지 못했습니다.";
      return;
    }
    preferencesStatus.textContent = "모바일 설정을 저장했습니다. 열려 있는 X 탭은 새로고침하면 반영됩니다.";
  });

  function renderLocalTreeEditor() {
    if (!localTree?.roots?.length) return;
    localPrimaryIndex = Math.min(Math.max(0, localPrimaryIndex), localTree.roots.length - 1);
    refreshLocalPrimaryOptions();
    const root = localTree.roots[localPrimaryIndex];
    localPrimaryName.value = root.name ?? "";
    localSecondaryGrid.replaceChildren();
    localSecondaryInputs = [];
    root.secondarySlots.forEach((value, index) => {
      const label = document.createElement("label");
      label.className = "secondary-slot-field";
      const slot = document.createElement("span");
      slot.textContent = `2차 슬롯 ${index + 1}`;
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 80;
      input.autocomplete = "off";
      input.value = value ?? "";
      input.placeholder = "빈 슬롯";
      localSecondaryInputs.push(input);
      label.append(slot, input);
      localSecondaryGrid.append(label);
    });
  }

  function refreshLocalPrimaryOptions() {
    if (!localTree?.roots?.length) return;
    const current = String(localPrimaryIndex);
    localPrimarySelect.replaceChildren();
    localTree.roots.forEach((root, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${index + 1}. ${root.name || "이름 없음"}`;
      localPrimarySelect.append(option);
    });
    localPrimarySelect.value = current;
  }

  function commitLocalEditor() {
    if (!localTree?.roots?.[localPrimaryIndex]) return;
    const root = localTree.roots[localPrimaryIndex];
    root.name = localPrimaryName.value.trim() || root.name;
    root.secondarySlots = Array.from({ length: 12 }, (_, index) => {
      const value = localSecondaryInputs[index]?.value?.trim() ?? "";
      return value || null;
    });
  }

  refreshButton.addEventListener("click", async () => {
    status.textContent = "Lakomics에 연결하는 중…";
    const hadTypedToken = tokenInput.value.trim().length > 0;
    const response = await LakomicsOptionsConnection.saveAndRefresh(
      (message) => chrome.runtime.sendMessage(message),
      tokenInput.value,
    );
    if (hadTypedToken && response.code !== "invalid_connection_key") tokenInput.value = "";
    if (!response.ok) {
      status.textContent = errorMessage(response.code);
      return;
    }
    entries = response.entries;
    workingLayout = response.layout;
    pinnedIds = response.pinnedIds;
    secondaryUsageById = response.usageById ?? secondaryUsageById;
    hiddenSecondaryIds = response.hiddenSecondaryIds ?? hiddenSecondaryIds;
    path = [];
    page = 0;
    selectedIndex = null;
    status.textContent = `연결됨 · 분류 ${entries.length}개`;
    renderEditor();
  });

  function renderEditor() {
    editor.replaceChildren();
    if (path.length === 0 && !workingLayout.parents?.[LakomicsRadial.PINNED]) {
      workingLayout = LakomicsRadial.reorderPinned(workingLayout, entries, pinnedIds);
    }
    const parentId = path.at(-1)?.id ?? null;
    const level = path.length === 0
      ? LakomicsRadial.getPinnedLevel(entries, workingLayout, pinnedIds, page)
      : LakomicsRadial.getLevel(entries, workingLayout, parentId, page);
    page = level.page;

    const heading = document.createElement("div");
    heading.className = "editor-heading";
    const title = document.createElement("strong");
    title.textContent = path.length ? path.map((entry) => entry.name).join(" › ") : "최상위 분류";
    const pageLabel = document.createElement("span");
    pageLabel.textContent = `${level.page + 1} / ${level.pageCount} 페이지`;
    heading.append(title, pageLabel);

    const radial = document.createElement("div");
    radial.className = "radial-editor";
    level.slots.forEach((entry, slotIndex) => {
      const angle = -Math.PI / 2 + (Math.PI * 2 * slotIndex) / level.slotCount;
      const x = `${Math.cos(angle) * 132}px`;
      const y = `${Math.sin(angle) * 132}px`;
      const globalIndex = level.page * level.slotCount + slotIndex;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "radial-slot";
      button.style.setProperty("--slot-x", x);
      button.style.setProperty("--slot-y", y);
      button.textContent = entry?.name ?? "빈 슬롯";
      button.classList.toggle("is-empty", !entry);
      button.classList.toggle("is-selected", selectedIndex === globalIndex);
      button.addEventListener("click", () => selectSlot(globalIndex, entry));
      radial.append(button);
    });
    const center = document.createElement("div");
    center.className = "radial-center";
    center.textContent = path.at(-1)?.name ?? "ROOT";
    radial.append(center);

    const controls = document.createElement("div");
    controls.className = "editor-controls";
    controls.append(
      controlButton("이전 페이지", level.page > 0, () => { page -= 1; selectedIndex = null; renderEditor(); }),
      controlButton("다음 페이지", level.page + 1 < level.pageCount, () => { page += 1; selectedIndex = null; renderEditor(); }),
      controlButton("한 단계 위", path.length > 0, () => { path.pop(); page = 0; selectedIndex = null; renderEditor(); }),
      controlButton("선택한 분류 열기", selectedHasChildren(level), () => openSelected(level)),
      controlButton("자동 배치로 초기화", true, () => {
        workingLayout = LakomicsRadial.resetLayout(entries);
        selectedIndex = null;
        renderEditor();
      }),
      controlButton("배치 저장", true, () => void saveLayout()),
    );

    const help = document.createElement("p");
    help.className = "editor-help";
    help.textContent = "분류 슬롯을 선택한 뒤 다른 슬롯을 누르면 두 위치를 바꿉니다. 빈 슬롯으로도 이동할 수 있습니다.";
    const blocks = [heading, renderPinnedPanel()];
    if (path.length > 0) blocks.push(renderSecondaryPresentationPanel(parentId));
    blocks.push(radial, controls, help);
    editor.append(...blocks);
  }

  function renderSecondaryPresentationPanel(parentId) {
    const panel = document.createElement("div");
    panel.className = "pinned-panel secondary-presentation-panel";
    const title = document.createElement("strong");
    title.textContent = "2차 도넛 자동 정렬 · 숨김";
    panel.append(title);
    const children = entries
      .filter((entry) => entry?.parentId === parentId && !pinnedIds.includes(entry.id))
      .sort((a, b) => (Number(secondaryUsageById[b.id]) || 0) - (Number(secondaryUsageById[a.id]) || 0)
        || String(a.name).localeCompare(String(b.name), "ko"));
    if (!children.length) {
      const empty = document.createElement("p");
      empty.className = "pinned-empty";
      empty.textContent = "이 분류의 2차 태그가 없습니다.";
      panel.append(empty);
      return panel;
    }
    const hidden = new Set(hiddenSecondaryIds);
    const list = document.createElement("div");
    list.className = "pinned-list";
    children.forEach((entry) => {
      const item = document.createElement("div");
      item.className = "pinned-item";
      const name = document.createElement("span");
      const count = Math.max(0, Math.floor(Number(secondaryUsageById[entry.id]) || 0));
      name.textContent = `${entry.name} · ${count}회`;
      const toggle = document.createElement("button");
      toggle.type = "button";
      const isHidden = hidden.has(entry.id);
      toggle.textContent = isHidden ? "다시 표시" : "숨기기";
      toggle.addEventListener("click", async () => {
        const response = await chrome.runtime.sendMessage({
          type: "secondary-presentation:set-hidden",
          classificationId: entry.id,
          hidden: !isHidden,
        });
        if (!response.ok) {
          status.textContent = "2차 태그 표시 설정을 저장하지 못했습니다.";
          return;
        }
        secondaryUsageById = response.usage ?? secondaryUsageById;
        hiddenSecondaryIds = response.hiddenIds ?? hiddenSecondaryIds;
        workingLayout = LakomicsRadial.adaptiveSecondaryLayout(
          entries, workingLayout, secondaryUsageById, hiddenSecondaryIds,
        );
        status.textContent = isHidden ? "2차 태그를 다시 표시합니다." : "2차 태그를 숨겼습니다.";
        renderEditor();
      });
      item.append(name, toggle);
      list.append(item);
    });
    panel.append(list);
    return panel;
  }

  function renderPinnedPanel() {
    const panel = document.createElement("div");
    panel.className = "pinned-panel";

    const title = document.createElement("strong");
    title.textContent = "1차 도넛에 고정된 분류";
    panel.append(title);

    const pinnedEntries = pinnedIds
      .map((id) => entries.find((entry) => entry.id === id))
      .filter(Boolean);

    if (pinnedEntries.length > 0) {
      const list = document.createElement("div");
      list.className = "pinned-list";
      pinnedEntries.forEach((entry) => {
        const item = document.createElement("div");
        item.className = "pinned-item";
        const name = document.createElement("span");
        name.textContent = classificationPathLabel(entry);
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.textContent = "해제";
        removeButton.addEventListener("click", () => {
          pinnedIds = pinnedIds.filter((id) => id !== entry.id);
          workingLayout = LakomicsRadial.reorderPinned(workingLayout, entries, pinnedIds);
          renderEditor();
          void persistPinnedLayout("고정을 해제했습니다.");
        });
        item.append(name, removeButton);
        list.append(item);
      });
      panel.append(list);
    } else {
      const empty = document.createElement("p");
      empty.className = "pinned-empty";
      empty.textContent = "아직 고정된 분류가 없습니다.";
      panel.append(empty);
    }

    const candidates = LakomicsRadial.getFirstLevelPinCandidates(entries, pinnedIds);
    if (candidates.length > 0) {
      const addRow = document.createElement("div");
      addRow.className = "pinned-add";
      const select = document.createElement("select");
      select.append(document.createElement("option"));
      candidates.forEach((entry) => {
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = classificationPathLabel(entry);
        select.append(option);
      });
      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.textContent = "고정";
      addButton.addEventListener("click", () => {
        const id = select.value;
        if (!id) return;
        pinnedIds = [...pinnedIds, id];
        workingLayout = LakomicsRadial.reorderPinned(workingLayout, entries, pinnedIds);
        renderEditor();
        void persistPinnedLayout("1차 도넛에 고정했습니다.");
      });
      addRow.append(select, addButton);
      panel.append(addRow);
    }

    return panel;
  }

  function classificationPathLabel(entry) {
    const byId = new Map(entries.filter((item) => item && typeof item.id === "string").map((item) => [item.id, item]));
    const names = [];
    const seen = new Set();
    let current = entry;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.push(current.name || current.id);
      current = current.parentId == null ? null : byId.get(current.parentId);
    }
    return names.reverse().join(" > ");
  }

  function selectSlot(globalIndex, entry) {
    if (selectedIndex === null) {
      if (!entry) return;
      selectedIndex = globalIndex;
    } else if (selectedIndex === globalIndex) {
      selectedIndex = null;
    } else {
      const parentId = path.length === 0 ? LakomicsRadial.PINNED : path.at(-1)?.id ?? null;
      workingLayout = LakomicsRadial.moveSlot(workingLayout, parentId, selectedIndex, globalIndex);
      selectedIndex = null;
    }
    renderEditor();
  }

  function selectedEntry(level) {
    if (selectedIndex === null) return null;
    const slot = selectedIndex - level.page * level.slotCount;
    return level.slots[slot] ?? null;
  }

  function selectedHasChildren(level) {
    const selected = selectedEntry(level);
    return Boolean(selected && entries.some((entry) => entry.parentId === selected.id));
  }

  function openSelected(level) {
    const selected = selectedEntry(level);
    if (!selected || !entries.some((entry) => entry.parentId === selected.id)) return;
    path.push(selected);
    page = 0;
    selectedIndex = null;
    renderEditor();
  }

  function persistPinnedLayout(successMessage = "방사형 메뉴 배치와 고정 분류를 저장했습니다.") {
    const pinnedSnapshot = [...pinnedIds];
    const layoutSnapshot = JSON.parse(JSON.stringify(workingLayout));
    const persist = async () => {
      const response = await chrome.runtime.sendMessage({
        type: "radial-state:set", pinnedIds: pinnedSnapshot, layout: layoutSnapshot,
      });
      if (!response.ok) { status.textContent = "고정 분류와 배치를 저장하지 못했습니다."; return false; }
      status.textContent = successMessage;
      return true;
    };
    pinnedPersistQueue = pinnedPersistQueue.then(persist, persist);
    return pinnedPersistQueue;
  }

  async function saveLayout() {
    await persistPinnedLayout();
  }

  function controlButton(label, enabled, action) {
    const button = document.createElement("button");
    button.type = "button";

    button.textContent = label;
    button.disabled = !enabled;
    button.addEventListener("click", action);
    return button;
  }

  function errorMessage(code) {
    if (code === "invalid_collector_token") return "서버 API 토큰을 확인하세요.";
    if (code === "collector_token_missing") return "서버 API 토큰을 먼저 저장하세요.";
    if (code === "invalid_collector_url") return "Lakomics VPS 주소를 확인하세요.";
    if (code === "collector_not_configured") return "VPS Capture Inbox를 켜고 서버 주소를 저장하세요.";
    if (code === "collector_unauthorized") return "서버 API 토큰이 일치하지 않습니다.";
    if (code === "collector_timeout") return "서버 연결 시간이 초과되었습니다.";
    if (code === "collector_offline") return "Lakomics 서버에 연결할 수 없습니다.";
    if (code === "collector_request_failed") return "Lakomics 서버 요청이 실패했습니다.";
    if (code === "invalid_connection_key") return "32자리 연결 키를 확인하시와요.";
    if (code === "invalid_remote_url") return "Tailscale Serve의 https://...ts.net 주소를 확인하시와요.";
    if (code === "remote_not_configured") return "원격 연결을 켜고 Tailscale Serve 주소를 저장하시와요.";
    if (code === "connection_key_missing") return "연결 키를 먼저 저장하세요.";
    if (code === "unauthorized") return "연결 키가 일치하지 않습니다.";
    if (code === "app_offline") return "Lakomics를 실행하고 라이브러리를 여세요.";
    if (code === "absolute_download_path_unsupported") return "절대 경로는 지정할 수 없습니다. Download 아래의 폴더 이름만 입력하세요.";
    if (code === "library_not_open") return "Lakomics에서 라이브러리를 여세요.";
    return "Lakomics에 연결하지 못했습니다.";
  }

  function describeErrorCode(code) {
    if (code === "connection_key_missing") return "연결 키 없음";
    if (code === "unauthorized") return "연결 키 불일치";
    if (code === "classification_not_found") return "분류 없음";
    return code;
  }

  function describeSavePolicy(mode) {
    if (mode === "pc") {
      savePolicyNote.textContent = "PC Lakomics(LAN/Tailscale)로만 저장합니다. PC에 연결할 수 없으면 저장이 실패하고 안내를 표시합니다.";
      return;
    }
    if (mode === "cloud") {
      savePolicyNote.textContent = "Cloud Capture로만 저장합니다. PC가 꺼져 있어도 동작하며, 실패 시 기존처럼 브라우저 Download로 저장합니다.";
      return;
    }
    if (mode === "download") {
      savePolicyNote.textContent = "Lakomics를 거치지 않고 브라우저 Download 폴더에 바로 저장합니다.";
      return;
    }
    savePolicyNote.textContent = "PC 직접 연결이 살아 있으면 PC로 저장하고, 아니면 Cloud로 보내고, 둘 다 실패하면 브라우저 Download로 저장합니다.";
  }

  function describeDiagnostics(settings) {
    const lines = [];
    const collector = settings.collector ?? {};
    const remote = settings.remote ?? {};
    const preferences = settings.preferences ?? {};

    const cloudParts = [];
    cloudParts.push(settings.collectorTokenConfigured ? "자격 증명 저장됨" : "자격 증명 없음");
    cloudParts.push(collector.enabled && collector.baseUrl ? `엔드포인트 ${collector.baseUrl}` : "엔드포인트 미설정");
    if (settings.lastCollectorFailure?.code) {
      cloudParts.push(`마지막 실패 ${describeErrorCode(settings.lastCollectorFailure.code)}`);
    } else if (settings.lastCollectorFailure) {
      cloudParts.push("마지막 실패 정보 없음");
    }
    lines.push({ label: "Cloud", detail: cloudParts.join(" · "), ok: collector.enabled === true && settings.collectorTokenConfigured });

    const pcParts = [];
    pcParts.push(settings.tokenConfigured ? "연결 키 저장됨" : "연결 키 없음");
    pcParts.push(remote.enabled && remote.baseUrl ? `Remote ${remote.baseUrl}` : "localhost 사용");
    if (settings.lastConnectionFailure?.code) {
      pcParts.push(`마지막 실패 ${describeErrorCode(settings.lastConnectionFailure.code)}`);
    }
    lines.push({ label: "PC 직접", detail: pcParts.join(" · "), ok: settings.tokenConfigured });

    const classification = settings.classificationDiagnostics ?? null;
    if (classification) {
      const sourceLabels = {
        app: "PC 분류 (직접)",
        remote: "PC 분류 (Remote)",
        "app-cache": "PC 분류 (캐시)",
        cloud: "Cloud 분류",
        "cloud-cache": "Cloud 분류 (캐시)",
        local: "로컬 기본 분류 · PC/Cloud 분류를 불러오지 못함",
      };
      const label = sourceLabels[classification.source] ?? classification.source;
      lines.push({
        label: "분류",
        detail: `${label} · ${classification.count}개${classification.fallbackReason ? ` · 사유: ${describeErrorCode(classification.fallbackReason)}` : ""}${classification.source === "local" ? " · 폴백" : ""}`,
        ok: classification.source !== "local",
      });
    }

    const saved = settings.savedMediaDiagnostics ?? null;
    if (saved) {
      const savedLabels = {
        app: "PC 로컬 인덱스",
        remote: "PC 인덱스 (Remote)",
        "app-cache": "PC 인덱스 (캐시)",
        cloud: "Cloud 스냅샷",
        "cloud-cache": "Cloud 스냅샷 (캐시)",
        none: "정보 없음",
      };
      lines.push({
        label: "저장됨 표시",
        detail: `${savedLabels[saved.source] ?? saved.source}${Number.isFinite(saved.keyCount) ? ` · ${saved.keyCount}키` : ""}`,
        ok: saved.source !== "none",
      });
    }

    lines.push({ label: "현재 저장 방식", detail: describeSavePolicyLabel(preferences.saveMode ?? "auto"), ok: true });
    return lines;
  }

  function describeSavePolicyLabel(mode) {
    if (mode === "pc") return "PC 직접 연결만";
    if (mode === "cloud") return "Cloud만";
    if (mode === "download") return "브라우저 Download만";
    return "자동";
  }

  function renderDiagnostics(settings) {
    const lines = describeDiagnostics(settings);
    diagnosticsSummary.replaceChildren(...lines.map((line) => {
      const item = document.createElement("p");
      item.className = "diagnostics-line";
      item.textContent = `${line.label}: ${line.detail}`;
      if (!line.ok) item.classList.add("diagnostics-degraded");
      return item;
    }));
  }
})();
