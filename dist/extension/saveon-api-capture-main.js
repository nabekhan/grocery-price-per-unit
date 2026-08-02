(() => {
  // src/retailers/saveon/api-capture-main.js
  (function injectPageWorldCapture(global) {
    const runtime = global.browser?.runtime || global.chrome?.runtime;
    const root = global.document?.documentElement;
    if (!runtime?.getURL || !root || root.dataset.sppuApiCaptureInjected) return;
    root.dataset.sppuApiCaptureInjected = "true";
    const script = global.document.createElement("script");
    script.src = runtime.getURL("saveon-api-capture-main.js");
    script.async = false;
    script.addEventListener("load", () => script.remove(), { once: true });
    script.addEventListener("error", () => {
      delete root.dataset.sppuApiCaptureInjected;
      script.remove();
    }, { once: true });
    root.prepend(script);
  })(globalThis);
  (function initializeSaveOnCapture(global) {
    "use strict";
    const SOURCE = "saveon-price-per-unit";
    const VERSION = 1;
    const INSTALL_KEY = Symbol.for("saveon-price-per-unit.api-capture.v1");
    if (global[INSTALL_KEY]) return;
    const state = { products: {}, revision: 0 };
    global[INSTALL_KEY] = state;
    const text = (value, maximum = 1e3) => typeof value === "string" && value.trim() ? value.trim().slice(0, maximum) : null;
    const number = (value) => {
      if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
      const match = text(value, 80)?.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    };
    const unitPrice = (value) => {
      const raw = text(value, 160);
      if (!raw) return null;
      return raw.replace(/^(\$\s*\d+(?:[.,]\d+)?)\s+(ea|each)$/i, "$1/$2");
    };
    const query = () => text(new URL(global.location.href).searchParams.get("q"), 256)?.normalize("NFKC").replace(/\s+/g, " ").toLowerCase() || null;
    function sanitize(raw) {
      const id = text(raw?.sku || raw?.productId, 160);
      const name = text(raw?.name, 1500);
      if (!id || !name || !/^[a-zA-Z0-9._:-]+$/.test(id)) return null;
      const size = raw.unitOfSize && typeof raw.unitOfSize === "object" ? {
        size: number(raw.unitOfSize.size),
        abbreviation: text(raw.unitOfSize.abbreviation, 32),
        type: text(raw.unitOfSize.type, 64)
      } : null;
      return {
        id,
        name,
        currentPrice: number(raw.priceNumeric ?? raw.wholePrice ?? raw.price),
        unitPrice: unitPrice(raw.unitPrice || raw.pricePerUnit),
        unitOfSize: size?.size && (size.abbreviation || size.type) ? size : null,
        sellBy: text(raw.sellBy, 40)
      };
    }
    function post(mode = "snapshot") {
      global.postMessage({
        source: SOURCE,
        version: VERSION,
        type: "api-products",
        mode,
        revision: ++state.revision,
        context: { query: query(), pagePath: `${global.location.pathname}${global.location.search}`.slice(0, 2048) },
        products: { ...state.products }
      }, global.location.origin);
    }
    function ingestProducts(values, mode = "batch") {
      if (!Array.isArray(values)) return false;
      const next = {};
      for (const value of values.slice(0, 500)) {
        const product = sanitize(value);
        if (product) next[product.id] = product;
      }
      if (!Object.keys(next).length) return false;
      if (mode === "snapshot") state.products = next;
      else Object.assign(state.products, next);
      post("snapshot");
      return true;
    }
    function readPreloaded() {
      const search = global.__PRELOADED_STATE__?.search;
      const ids = search?.products?.searchResults;
      const dictionary = search?.productCardDictionary;
      if (!Array.isArray(ids) || !dictionary || typeof dictionary !== "object") return false;
      return ingestProducts(ids.map((id) => dictionary[id]).filter(Boolean), "snapshot");
    }
    function findProductArrays(value, found = [], seen = /* @__PURE__ */ new Set(), depth = 0) {
      if (!value || typeof value !== "object" || seen.has(value) || depth > 8 || found.length >= 500) return found;
      seen.add(value);
      if (Array.isArray(value)) {
        if (value.some((item) => item?.sku && item?.name && (item?.unitPrice || item?.unitOfSize))) found.push(...value);
        else for (const item of value.slice(0, 100)) findProductArrays(item, found, seen, depth + 1);
      } else {
        const values = Object.values(value);
        if (values.some((item) => item?.sku && item?.name && (item?.unitPrice || item?.unitOfSize))) found.push(...values);
        else for (const item of values.slice(0, 100)) findProductArrays(item, found, seen, depth + 1);
      }
      return found;
    }
    function inspectResponse(response) {
      response.clone().json().then((payload) => ingestProducts(findProductArrays(payload))).catch(() => {
      });
    }
    function isSaveOnApi(value) {
      try {
        const url = new URL(String(value || ""), global.location.href);
        return /(^|\.)saveonfoods\.com$/i.test(url.hostname) && url.pathname.startsWith("/api/");
      } catch {
        return false;
      }
    }
    if (global.fetch) {
      const nativeFetch = global.fetch;
      global.fetch = async function observedFetch(...args) {
        const response = await nativeFetch.apply(this, args);
        const url = String(args[0]?.url || args[0] || "");
        if (isSaveOnApi(url)) inspectResponse(response);
        return response;
      };
    }
    const xhr = global.XMLHttpRequest?.prototype;
    if (xhr) {
      const nativeOpen = xhr.open;
      const nativeSend = xhr.send;
      xhr.open = function observedOpen(method, url, ...args) {
        this.__sppuApiResponse = isSaveOnApi(url);
        return nativeOpen.call(this, method, url, ...args);
      };
      xhr.send = function observedSend(body) {
        if (this.__sppuApiResponse) {
          this.addEventListener("load", () => {
            try {
              ingestProducts(findProductArrays(JSON.parse(this.responseText)));
            } catch {
            }
          }, { once: true });
        }
        return nativeSend.call(this, body);
      };
    }
    let attempts = 0;
    const timer = global.setInterval(() => {
      attempts += 1;
      if (readPreloaded() || attempts >= 100) global.clearInterval(timer);
    }, 50);
    global.addEventListener("DOMContentLoaded", readPreloaded, { once: true });
    global.addEventListener("message", (event) => {
      if (event.source !== global || event.origin !== global.location.origin) return;
      if (event.data?.source === SOURCE && event.data?.version === VERSION && event.data?.type === "api-products-request") {
        if (!readPreloaded()) post();
      }
    });
  })(window);
})();
