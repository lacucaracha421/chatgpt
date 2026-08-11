(() => {
  "use strict";

  const tokenInput = document.querySelector("#connection-token");
  const saveButton = document.querySelector("#save-token");
  const refreshButton = document.querySelector("#refresh-classifications");
  const status = document.querySelector("#connection-status");
  const editor = document.querySelector("#layout-editor");
  let entries = [];
  let workingLayout = { version: 1, parents: {} };
  let path = [];
  let page = 0;
  let selectedIndex = null;

  void initialize();

  async function initialize() {
    const settings = await chrome.runtime.sendMessage({ type: "settings:get" });
    status.textContent = settings.tokenConfigured ? "연결 키가 저장되어 있습니다." : "Lakomics에서 연결 키를 복사해 입력하세요.";
    const stored = await chrome.runtime.sendMessage({ type: "layout:get" });
    if (stored.ok) workingLayout = stored.layout;
  }

  saveButton.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({
      type: "settings:set-token",
      token: tokenInput.value,
    });
    if (!response.ok) {
      status.textContent = "32자리 연결 키를 확인하세요.";
      return;
    }
    tokenInput.value = "";
    status.textContent = "연결 키를 저장했습니다.";
  });

  refreshButton.addEventListener("click", async () => {
    status.textContent = "Lakomics에 연결하는 중…";
    const response = await chrome.runtime.sendMessage({ type: "classifications:refresh" });
    if (!response.ok) {
      status.textContent = errorMessage(response.code);
      return;
    }
    entries = response.entries;
    workingLayout = response.layout;
    path = [];
    page = 0;
    selectedIndex = null;
    status.textContent = `연결됨 · 분류 ${entries.length}개`;
    renderEditor();
  });

  function renderEditor() {
    editor.replaceChildren();
    const parentId = path.at(-1)?.id ?? null;
    const level = LakomicsRadial.getLevel(entries, workingLayout, parentId, page);
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
      const button = document.createElement("button");
      button.type = "button";
      button.className = "radial-slot";
      button.style.setProperty("--slot-x", `${Math.cos(angle) * 132}px`);
      button.style.setProperty("--slot-y", `${Math.sin(angle) * 132}px`);
      button.textContent = entry?.name ?? "빈 슬롯";
      const globalIndex = level.page * level.slotCount + slotIndex;
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
    editor.append(heading, radial, controls, help);
  }

  function selectSlot(globalIndex, entry) {
    if (selectedIndex === null) {
      if (!entry) return;
      selectedIndex = globalIndex;
    } else if (selectedIndex === globalIndex) {
      selectedIndex = null;
    } else {
      const parentId = path.at(-1)?.id ?? null;
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
    status.textContent = response.ok ? "방사형 메뉴 배치를 저장했습니다." : "배치를 저장하지 못했습니다.";
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
    if (code === "connection_key_missing") return "연결 키를 먼저 저장하세요.";
    if (code === "unauthorized") return "연결 키가 일치하지 않습니다.";
    if (code === "app_offline") return "Lakomics를 실행하고 라이브러리를 여세요.";
    if (code === "library_not_open") return "Lakomics에서 라이브러리를 여세요.";
    return "Lakomics에 연결하지 못했습니다.";
  }
})();
