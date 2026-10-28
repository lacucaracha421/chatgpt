(() => {
  "use strict";

  const AV_LOOKUP_SITES = Object.freeze([
    Object.freeze({ id: "javlibrary", label: "JAVLibrary", url: "https://www.javlibrary.com/ja/vl_searchbyid.php?keyword={q}" }),
  ]);
  const PRODUCT_CODE_PREFIX = String.raw`(?:\d{1,4}[A-Za-z]{2,6}|[A-Za-z]{2,6}\d(?:[A-Za-z]{2,6}|[-\s][A-Za-z]{2,6})?|[A-Za-z]{2,6})`;
  const PRODUCT_CODE_RE = new RegExp(String.raw`(?<![A-Za-z0-9])(${PRODUCT_CODE_PREFIX}[-\s]?\d{2,7}[A-Za-z]?)(?![A-Za-z0-9])`, "gi");
  const PRODUCT_CODE_EXACT_RE = new RegExp(String.raw`^${PRODUCT_CODE_PREFIX.replaceAll("[A-Za-z]", "[A-Z]")}[-\s]?\d{2,7}[A-Z]?$`);

  function collapseWhitespace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function canonicalPrefix(value) {
    const prefix = value.replace(/\s+/g, "-").replace(/-+/g, "-");
    const embedded = prefix.match(/^([A-Z]{2,6}\d)([A-Z]{2,6})$/);
    return embedded ? `${embedded[1]}-${embedded[2]}` : prefix;
  }

  function normalizeProductCode(value) {
    const text = collapseWhitespace(value).toUpperCase();
    if (!PRODUCT_CODE_EXACT_RE.test(text)) return "";
    const match = text.match(/^(.+?)[-\s]?(\d{2,7})([A-Z]?)$/);
    if (!match) return "";
    let prefix = canonicalPrefix(match[1]);
    let digits = match[2];
    if (!match[3]) {
      // Use the inbox's canonical code for numeric provider prefixes and padding.
      if (/^\d+[A-Z]+$/.test(prefix) && !/^\d+(?:LUXU|GANA|MAAN|ARA|MIUM|PRESTIGE)$/.test(prefix)) {
        prefix = prefix.replace(/^\d+/, "");
      }
      if (!text.includes("-")) digits = digits.replace(/^0+/, "") || "0";
      digits = digits.padStart(3, "0");
    }
    return `${prefix}-${digits}${match[3]}`;
  }

  function productCodeFromText(value) {
    const text = collapseWhitespace(value);
    return productCodesInText(text)[0]?.code || "";
  }

  function productCodesInText(value) {
    const text = String(value ?? "");
    return Array.from(text.matchAll(PRODUCT_CODE_RE), match => ({
      code: normalizeProductCode(match[1]), start: match.index, end: match.index + match[1].length,
    })).filter(match => match.code);
  }

  function normalizeQuery(value) {
    const text = collapseWhitespace(value);
    const code = productCodeFromText(text);
    if (code) return code;
    if (!text || Array.from(text).length > 60) return "";
    return text;
  }

  function buildLookupUrls(value) {
    const query = normalizeQuery(value);
    if (!query) return [];
    const encoded = encodeURIComponent(query);
    return AV_LOOKUP_SITES.map(site => site.url.replace("{q}", encoded));
  }

  function createSendRequest(value, sourceUrl) {
    const productCode = productCodeFromText(value);
    if (!productCode) return null;
    return { requestId: crypto.randomUUID(), productCode, sourceUrl: sourceUrl || null };
  }

  globalThis.LakomicsAvLookup = {
    AV_LOOKUP_SITES,
    buildLookupUrls,
    createSendRequest,
    collapseWhitespace,
    normalizeProductCode,
    normalizeQuery,
    productCodeFromText,
    productCodesInText,
  };
})();
