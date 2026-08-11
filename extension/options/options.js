(() => {
  "use strict";

  const tokenInput = document.querySelector("#connection-token");
  const saveButton = document.querySelector("#save-token");
  const refreshButton = document.querySelector("#refresh-classifications");
  const status = document.querySelector("#connection-status");
  const editor = document.querySelector("#layout-editor");

  void initialize();

  async function initialize() {
    const settings = await chrome.runtime.sendMessage({ type: "settings:get" });
    status.textContent = settings.tokenConfigured ? "연결 키가 저장되어 있습니다." : "Lakomics에서 연결 키를 복사해 입력하세요.";
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
    status.textContent = `연결됨 · 분류 ${response.entries.length}개`;
    editor.textContent = "분류를 불러왔습니다. 다음 단계에서 슬롯 편집기를 표시합니다.";
  });

  function errorMessage(code) {
    if (code === "connection_key_missing") return "연결 키를 먼저 저장하세요.";
    if (code === "unauthorized") return "연결 키가 일치하지 않습니다.";
    if (code === "app_offline") return "Lakomics를 실행하고 라이브러리를 여세요.";
    if (code === "library_not_open") return "Lakomics에서 라이브러리를 여세요.";
    return "Lakomics에 연결하지 못했습니다.";
  }
})();
