(() => {
  "use strict";

  const MOBILE_ORIGIN = "https://lacucaracha421.github.io/*";

  async function checkMobileAccess(permissions) {
    if (typeof permissions?.contains !== "function") return { state: "error" };
    try {
      const granted = await permissions.contains({ origins: [MOBILE_ORIGIN] });
      return { state: granted === true ? "granted" : "needed" };
    } catch {
      return { state: "error" };
    }
  }

  async function requestMobileAccess(permissions) {
    let requestFailed = false;
    try {
      if (typeof permissions?.request !== "function") throw new Error("permissions_request_unavailable");
      await permissions.request({ origins: [MOBILE_ORIGIN] });
    } catch {
      requestFailed = true;
    }

    const checked = await checkMobileAccess(permissions);
    if (checked.state === "granted") return checked;
    if (requestFailed || checked.state === "error") return { state: "error" };
    return { state: "needed" };
  }

  globalThis.LakomicsMobileAccess = {
    MOBILE_ORIGIN,
    checkMobileAccess,
    requestMobileAccess,
  };
})();
