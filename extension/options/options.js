(() => {
  "use strict";

  const tokenInput = document.querySelector("#connection-token");
  const refreshButton = document.querySelector("#refresh-classifications");
  const status = document.querySelector("#connection-status");
  const editor = document.querySelector("#layout-editor");
  let entries = [];
  let workingLayout = { version: 1, parents: {} };
  let path = [];
  let page = 0;
  let selectedIndex = null;
  let pinnedIds = [];

  void initialize();

  async function initialize() {
    const settings = await chrome.runtime.sendMessage({ type: "settings:get" });
    status.textContent = settings.tokenConfigured ? "연결 키가 저장되어 있습니다." : "Lakomics에서 연결 키를 복사해 입력하세요.";
    const stored = await chrome.runtime.sendMessage({ type: "layout:get" });
    if (stored.ok) workingLayout = stored.layout;
    const pinned = await chrome.runtime.sendMessage({ type: "pinned:get" });
    if (pinned.ok) pinnedIds = pinned.pinnedIds;
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

    const candidates = entries.filter((entry) => entry.parentId !== null && !pinnedIds.includes(entry.id));
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

  async function saveLayout() {
    const response = await chrome.runtime.sendMessage({ type: "layout:set", layout: workingLayout });
    if (!response.ok) {
      status.textContent = "배치를 저장하지 못했습니다.";
      return;
    }
    const pinned = await chrome.runtime.sendMessage({ type: "pinned:set", pinnedIds });
    status.textContent = pinned.ok
      ? "방사형 메뉴 배치와 고정 분류를 저장했습니다."
      : "배치를 저장했지만 고정 분류를 저장하지 못했습니다.";
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
    if (code === "invalid_connection_key") return "32자리 연결 키를 확인하세요.";
    if (code === "connection_key_missing") return "연결 키를 먼저 저장하세요.";
    if (code === "unauthorized") return "연결 키가 일치하지 않습니다.";
    if (code === "app_offline") return "Lakomics를 실행하고 라이브러리를 여세요.";
    if (code === "library_not_open") return "Lakomics에서 라이브러리를 여세요.";
    return "Lakomics에 연결하지 못했습니다.";
  }
})();
