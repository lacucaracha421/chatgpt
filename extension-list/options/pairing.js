(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  let value = "", parsed = null, expectedConnection = null, busy = false;
  try { value = decodeURIComponent(location.hash.slice(1)); } catch {}
  history.replaceState(null, "", location.pathname);
  parsed = globalThis.LakomicsListApi.parsePairing(value);
  $("cancel").onclick = () => { value = ""; window.close(); };
  if (!parsed) { $("status").textContent = "유효하지 않은 연결 링크입니다."; return; }
  $("target").textContent = parsed.origin;
  chrome.runtime.sendMessage({ type: "settings:get" }).then(settings => {
    if (!settings?.ok) throw new Error();
    expectedConnection = settings.connectionIdentity;
    $("existing").hidden = !settings.paired;
    $("current").textContent = settings.origin || "";
    $("confirm").textContent = settings.paired ? "기존 연결을 이 서버로 교체" : "이 서버에 연결";
    $("confirm").disabled = false;
  }).catch(() => { $("status").textContent = "현재 연결을 확인하지 못했습니다. 연결 링크를 다시 여세요."; });
  $("confirm").onclick = async () => {
    if (busy || $("confirm").disabled) return;
    busy = true; $("confirm").disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "pair", value, confirmedOrigin: parsed.origin, expectedConnection });
      $("status").textContent = result?.ok ? "연결됨" : result?.code === "connection_changed"
        ? "현재 연결이 바뀌었습니다. 연결 링크를 다시 열고 확인하세요."
        : "연결하지 못했습니다. PC에서 새 링크를 발급하고 다시 시도하세요.";
    } catch { $("status").textContent = "확장 프로그램이 응답하지 않습니다. 연결 링크를 다시 여세요."; }
    value = "";
  };
})();
