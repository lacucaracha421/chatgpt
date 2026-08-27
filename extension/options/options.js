(() => {
  "use strict";

  const tokenInput = document.querySelector("#connection-token");
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
  let entries = [];
  let workingLayout = { version: 1, parents: {} };
  let path = [];
  let page = 0;
  let selectedIndex = null;
  let pinnedIds = [];
  let localTree = null;
  let localPrimaryIndex = 0;
  let localSecondaryInputs = [];

  void initialize();

  async function initialize() {
    const settings = await chrome.runtime.sendMessage({ type: "settings:get" });
    status.textContent = settings.tokenConfigured ? "연결 키가 저장되어 있습니다." : "Lakomics에서 연결 키를 복사해 입력하세요.";
    const preferences = settings.preferences ?? {};
    const remote = settings.remote ?? {};
    remoteEnabled.checked = remote.enabled === true;
    remoteBaseUrl.value = remote.baseUrl ?? "";
    downloadFolder.value = preferences.downloadFolder ?? "Lakomics";
    touchLongPress.value = String(preferences.touchLongPressMs ?? 450);
    suppressDownloadUi.checked = preferences.suppressDownloadUi === true;
    autoLikeOnSave.checked = preferences.autoLikeOnSave !== false;
    preferencesStatus.textContent = settings.downloadsApiAvailable
      ? (settings.downloadsUiApiAvailable ? "모바일 다운로드 UI 제어 사용 가능" : "다운로드 UI 숨김 API를 찾지 못했습니다.")
      : "확장 다운로드 API를 찾지 못했습니다.";
    const translateStored = await chrome.storage.local.get(["xTranslateEnabled"]);
    xTranslateEnabled.checked = translateStored.xTranslateEnabled !== false;
    xTranslateStatus.textContent = xTranslateEnabled.checked
      ? "활성화됨 · X에서 訳 버튼으로 설정할 수 있습니다."
      : "꺼져 있습니다.";
    const stored = await chrome.runtime.sendMessage({ type: "layout:get" });
    if (stored.ok) workingLayout = stored.layout;
    const pinned = await chrome.runtime.sendMessage({ type: "pinned:get" });
    if (pinned.ok) pinnedIds = pinned.pinnedIds;
    const local = await chrome.runtime.sendMessage({ type: "local-tree:get" });
    if (local.ok) {
      localTree = local.tree;
      renderLocalTreeEditor();
    }
  }


  xTranslateEnabled.addEventListener("change", async () => {
    await chrome.storage.local.set({ xTranslateEnabled: xTranslateEnabled.checked });
    xTranslateStatus.textContent = xTranslateEnabled.checked
      ? "X Translate를 켰습니다. 열려 있는 X 탭을 새로고침하면 적용됩니다."
      : "X Translate를 껐습니다. 열려 있는 X 탭을 새로고침하면 사라집니다.";
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
    editor.append(heading, renderPinnedPanel(), radial, controls, help);
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
        name.textContent = entry.name;
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
        option.textContent = entry.name;
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

  async function persistPinnedLayout(successMessage = "방사형 메뉴 배치와 고정 분류를 저장했습니다.") {
    const pinned = await chrome.runtime.sendMessage({ type: "pinned:set", pinnedIds });
    if (!pinned.ok) { status.textContent = "고정 분류를 저장하지 못했습니다."; return false; }
    const response = await chrome.runtime.sendMessage({ type: "layout:set", layout: workingLayout });
    if (!response.ok) { status.textContent = "고정은 저장했지만 배치를 저장하지 못했습니다."; return false; }
    status.textContent = successMessage;
    return true;
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
})();
