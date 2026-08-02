(() => {
  // src/parsing/units.js
  var UNITS = Object.freeze({
    mg: { dimension: "mass", baseFactor: 1e-6, normalizedUnit: "$/kg" },
    g: { dimension: "mass", baseFactor: 1e-3, normalizedUnit: "$/kg" },
    kg: { dimension: "mass", baseFactor: 1, normalizedUnit: "$/kg" },
    oz: { dimension: "mass", baseFactor: 0.028349523125, normalizedUnit: "$/kg" },
    lb: { dimension: "mass", baseFactor: 0.45359237, normalizedUnit: "$/kg" },
    ml: { dimension: "volume", baseFactor: 1e-3, normalizedUnit: "$/L" },
    l: { dimension: "volume", baseFactor: 1, normalizedUnit: "$/L" },
    ea: { dimension: "count", baseFactor: 1, normalizedUnit: "$/each" },
    each: { dimension: "count", baseFactor: 1, normalizedUnit: "$/each" },
    count: { dimension: "count", baseFactor: 1, normalizedUnit: "$/each" },
    ct: { dimension: "count", baseFactor: 1, normalizedUnit: "$/each" },
    pack: { dimension: "count", baseFactor: 1, normalizedUnit: "$/each" },
    rolls: { dimension: "count", baseFactor: 1, normalizedUnit: "$/each" },
    roll: { dimension: "count", baseFactor: 1, normalizedUnit: "$/each" },
    boxes: { dimension: "count", baseFactor: 1, normalizedUnit: "$/each" },
    box: { dimension: "count", baseFactor: 1, normalizedUnit: "$/each" }
  });
  function canonicalUnit(raw) {
    const key = raw.toLowerCase().replace(/\./g, "");
    const aliases = { milligram: "mg", milligrams: "mg", gram: "g", grams: "g", kilogram: "kg", kilograms: "kg", ounce: "oz", ounces: "oz", pound: "lb", pounds: "lb", millilitre: "ml", millilitres: "ml", milliliter: "ml", milliliters: "ml", litre: "l", litres: "l", liter: "l", liters: "l", pcs: "count", pieces: "count", pc: "count", units: "count" };
    return aliases[key] || key;
  }

  // src/parsing/parser.js
  var NUMBER = "(\\d+(?:[.,]\\d+)?)";
  var UNIT = "(mg|g|kg|oz|lb|ml|l|ea|each|count|ct|pack|rolls?|boxes?|milligrams?|grams?|kilograms?|ounces?|pounds?|millilit(?:re|er)s?|lit(?:re|er)s?)";
  function clean(text = "") {
    return String(text).replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
  }
  function number(raw) {
    if (!raw) return null;
    const normalized = raw.includes(",") && !raw.includes(".") ? raw.replace(",", ".") : raw.replace(/,/g, "");
    const value = Number(normalized);
    return Number.isFinite(value) ? value : null;
  }
  function parseMoney(text) {
    const match = clean(text).match(/\$\s*(\d+(?:[.,]\d{1,2})?)/);
    return match ? number(match[1]) : null;
  }
  function parseExplicitUnitPrice(rawText) {
    const text = clean(rawText).toLowerCase();
    if (/fl\.?\s*oz/.test(text)) return { source: "ambiguous", confidence: "low", warnings: ["Fluid-ounce standard is not specified."] };
    const pattern = new RegExp(`\\$\\s*${NUMBER}\\s*(?:\\/|per\\s+)\\s*${NUMBER}?\\s*${UNIT}\\b`, "i");
    const match = text.match(pattern);
    if (!match) return null;
    const price = number(match[1]);
    const quantity = number(match[2]) || 1;
    const unit = canonicalUnit(match[3]);
    const info = UNITS[unit];
    if (!info || !price || !quantity) return null;
    return {
      dimension: info.dimension,
      normalizedUnitPrice: price / (quantity * info.baseFactor),
      normalizedUnit: info.normalizedUnit,
      source: "explicit-site-unit-price",
      confidence: "high",
      warnings: []
    };
  }
  function parsePackageQuantity(rawText) {
    const text = clean(rawText).toLowerCase();
    if (!text) return null;
    if (/\b(?:equals?|equiv(?:alent)?)\b|\d+\s*rolls?\s*=/.test(text)) {
      return { source: "ambiguous", confidence: "low", warnings: ["Marketing equivalency was not used as physical count."] };
    }
    if (/fl\.?\s*oz/.test(text)) return { source: "ambiguous", confidence: "low", warnings: ["Fluid-ounce standard is not specified."] };
    let match = text.match(new RegExp(`${NUMBER}\\s*[x\xD7]\\s*${NUMBER}\\s*${UNIT}\\b`, "i"));
    if (match) {
      const multiplier = number(match[1]);
      const quantity2 = number(match[2]);
      const unit2 = canonicalUnit(match[3]);
      const info2 = UNITS[unit2];
      if (info2) return { dimension: info2.dimension, baseQuantity: multiplier * quantity2 * info2.baseFactor, normalizedUnit: info2.normalizedUnit, source: "calculated-from-package", confidence: "high", warnings: [] };
    }
    match = text.match(/\b(\d+)\s*[x×]\s*(\d+)\b/i);
    if (match) return { dimension: "count", baseQuantity: number(match[1]) * number(match[2]), normalizedUnit: "$/each", source: "calculated-from-package", confidence: "medium", warnings: ["Interpreted an unlabelled multi-pack as item count."] };
    match = text.match(new RegExp(`${NUMBER}\\s*${UNIT}\\b`, "i"));
    if (!match) return null;
    const quantity = number(match[1]);
    const unit = canonicalUnit(match[2]);
    const info = UNITS[unit];
    if (!info || !quantity) return null;
    return { dimension: info.dimension, baseQuantity: quantity * info.baseFactor, normalizedUnit: info.normalizedUnit, source: "calculated-from-package", confidence: "high", warnings: [] };
  }
  function parseProduct(input) {
    const unit = parseExplicitUnitPrice(input.rawUnitPriceText || input.rawPackageText || "");
    const warnings = [];
    const result = {
      productId: input.productId || null,
      name: clean(input.name),
      currentPrice: input.currentPrice ?? parseMoney(input.currentPriceText),
      regularPrice: input.regularPrice ?? parseMoney(input.regularPriceText),
      rawPackageText: clean(input.rawPackageText),
      rawUnitPriceText: clean(input.rawUnitPriceText),
      dimension: null,
      normalizedUnitPrice: null,
      normalizedUnit: null,
      source: "unknown",
      confidence: "none",
      warnings
    };
    if (unit) return { ...result, ...unit, warnings: [...warnings, ...unit.warnings || []] };
    const promoText = clean(input.promotionText);
    const conditional = /\b(?:min(?:imum)?\s*\d+|\d+\s*for\s*\$|member|after limit)\b/i.test(promoText);
    if (conditional && !input.currentPriceCertain) {
      return { ...result, source: "ambiguous", confidence: "low", warnings: ["Conditional promotion was not treated as a certain single-item price."] };
    }
    const quantity = parsePackageQuantity(input.rawPackageText);
    if (quantity?.dimension && result.currentPrice != null) {
      return { ...result, dimension: quantity.dimension, normalizedUnitPrice: result.currentPrice / quantity.baseQuantity, normalizedUnit: quantity.normalizedUnit, source: "calculated-from-package", confidence: quantity.confidence, warnings: quantity.warnings };
    }
    if (quantity?.source === "ambiguous") return { ...result, source: "ambiguous", confidence: quantity.confidence, warnings: quantity.warnings };
    return result;
  }

  // src/retailers/loblaw/site.js
  function directChildUnder(node, container) {
    let child = node;
    while (child?.parentElement && child.parentElement !== container) child = child.parentElement;
    return child?.parentElement === container ? child : null;
  }
  function findProductGrid(document2) {
    const listing = document2.querySelector('[data-testid="listing-page-container"]');
    const semanticGrids = listing ? [...listing.querySelectorAll('[data-testid="product-grid-component"]')] : [];
    if (semanticGrids.length) {
      const cards = semanticGrids.flatMap((grid) => [...grid.querySelectorAll(":scope > *")].filter((child) => child.querySelector('[data-testid="product-title"]')));
      if (cards.length >= 3) return [semanticGrids.find((grid) => grid.children.length) || semanticGrids[0], cards, semanticGrids];
    }
    const titles = [...document2.querySelectorAll('[data-testid="product-title"]')];
    const candidates = /* @__PURE__ */ new Map();
    for (const title of titles) {
      let ancestor = title.parentElement;
      while (ancestor && ancestor !== document2.body) {
        const count = ancestor.querySelectorAll('[data-testid="product-title"]').length;
        if (count >= 3) {
          const cards = [...new Set(titles.map((item) => directChildUnder(item, ancestor)).filter(Boolean))];
          if (cards.length >= 3) candidates.set(ancestor, cards);
          break;
        }
        ancestor = ancestor.parentElement;
      }
    }
    return [...candidates.entries()].sort((a, b) => b[1].length - a[1].length)[0] || null;
  }
  function productId(card, index) {
    const link = card.querySelector('a[href*="/product/"], a[href*="/p/"]');
    const href = link?.getAttribute("href") || "";
    return href.match(/(?:product|p)\/([^/?#]+)/)?.[1] || card.getAttribute("data-product-id") || `loaded-${index}`;
  }
  function extractCard(card, index = 0, apiProducts2 = null) {
    const cardProductId = productId(card, index);
    const api = apiProducts2?.get(cardProductId) || null;
    const apiPackageText = api?.packageSizing || "";
    const hasExplicitUnitPrice = /\$\s*\d.*(?:\/|\bper\b)/i.test(apiPackageText);
    const input = api ? {
      productId: cardProductId,
      name: api.name,
      currentPrice: api.weighted && !hasExplicitUnitPrice ? null : api.currentPrice,
      regularPrice: api.regularPrice,
      rawPackageText: apiPackageText.split(",")[0] || apiPackageText,
      rawUnitPriceText: apiPackageText.includes(",") ? apiPackageText.slice(apiPackageText.indexOf(",") + 1) : apiPackageText,
      promotionText: "",
      currentPriceCertain: true
    } : {
      productId: cardProductId,
      name: "",
      currentPrice: null,
      regularPrice: null,
      rawPackageText: "",
      rawUnitPriceText: "",
      promotionText: "",
      currentPriceCertain: false
    };
    return {
      ...parseProduct(input),
      dataSource: api ? "api" : "missing-api",
      card
    };
  }
  function extractGrid(document2, apiProducts2 = null) {
    const match = findProductGrid(document2);
    if (!match) return null;
    const [container, cards, containers = [container]] = match;
    return { container, containers, models: cards.map((card, index) => extractCard(card, index, apiProducts2)) };
  }

  // src/sorting/sort.js
  var DIMENSIONS = ["mass", "volume", "count"];
  function predominantDimension(items) {
    const counts = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
    for (const item of items) if (item.dimension && Number.isFinite(item.normalizedUnitPrice)) counts[item.dimension] += 1;
    return DIMENSIONS.reduce((best, candidate) => counts[candidate] > counts[best] ? candidate : best, "mass");
  }
  function sortModels(items, { dimension = "auto", direction = "asc" } = {}) {
    const hasUnitPrices = items.some((item) => DIMENSIONS.includes(item.dimension) && Number.isFinite(item.normalizedUnitPrice));
    const selected = dimension === "auto" ? hasUnitPrices ? predominantDimension(items) : "total" : dimension;
    const sign = direction === "desc" ? -1 : 1;
    const value = (item) => selected === "total" ? item.currentPrice : item.normalizedUnitPrice;
    const remainingDimensions = DIMENSIONS.filter((candidate) => candidate !== selected);
    const group = (item) => {
      if (selected === "total") return Number.isFinite(item.currentPrice) ? 0 : Number.MAX_SAFE_INTEGER;
      if (item.dimension === selected && Number.isFinite(item.normalizedUnitPrice)) return 0;
      const index = remainingDimensions.indexOf(item.dimension);
      return index >= 0 && Number.isFinite(item.normalizedUnitPrice) ? index + 1 : Number.MAX_SAFE_INTEGER;
    };
    return {
      dimension: selected,
      items: items.map((item, index) => ({ item, index })).sort((a, b) => {
        const aGroup = group(a.item);
        const bGroup = group(b.item);
        if (aGroup !== bGroup) return aGroup - bGroup;
        if (aGroup === Number.MAX_SAFE_INTEGER) return a.index - b.index;
        return sign * (value(a.item) - value(b.item)) || a.index - b.index;
      }).map(({ item }) => item)
    };
  }

  // src/ui/control.js
  var LABELS = { mass: "$/kg", volume: "$/L", count: "$/each", total: "total price" };
  var OPTIONS = [
    ["restore", "Website order", null, null, "Website order", "Use the retailer\u2019s relevance sorting"],
    ["auto-asc", "Automatic", "auto", "asc", "Auto \xB7 Low \u2192 high", "Predominant unit \xB7 Low to high"],
    ["auto-desc", "Automatic", "auto", "desc", "Auto \xB7 High \u2192 low", "Predominant unit \xB7 High to low"],
    ["mass-asc", "By weight", "mass", "asc", "$/kg \xB7 Low \u2192 high", "Comparable price per kilogram \xB7 Low to high"],
    ["mass-desc", "By weight", "mass", "desc", "$/kg \xB7 High \u2192 low", "Comparable price per kilogram \xB7 High to low"],
    ["volume-asc", "By volume", "volume", "asc", "$/L \xB7 Low \u2192 high", "Comparable price per litre \xB7 Low to high"],
    ["volume-desc", "By volume", "volume", "desc", "$/L \xB7 High \u2192 low", "Comparable price per litre \xB7 High to low"],
    ["count-asc", "By count", "count", "asc", "$/each \xB7 Low \u2192 high", "Comparable price per item \xB7 Low to high"],
    ["count-desc", "By count", "count", "desc", "$/each \xB7 High \u2192 low", "Comparable price per item \xB7 High to low"],
    ["total-asc", "Total price", "total", "asc", "Total \xB7 Low \u2192 high", "Current API price \xB7 Low to high"],
    ["total-desc", "Total price", "total", "desc", "Total \xB7 High \u2192 low", "Current API price \xB7 High to low"]
  ];
  function activeValue(state2) {
    return state2.restored ? "restore" : `${state2.dimension}-${state2.direction}`;
  }
  function makeTick(template) {
    if (template) return template.cloneNode(true);
    const tick = document.createElement("span");
    tick.className = "lups-menu-tick";
    tick.setAttribute("aria-hidden", "true");
    tick.textContent = "\u2713";
    return tick;
  }
  function createNativeControl(nativeSection, onChange, state2, adapter = {}) {
    const root = document.createElement("section");
    root.id = "lups-control";
    root.dataset.lupsFloating = "true";
    root.setAttribute("aria-label", "Unit price sorting");
    const nativeInner = nativeSection.firstElementChild;
    const inner = document.createElement("div");
    inner.className = nativeInner?.className || "";
    inner.style.position = "relative";
    const nativeLabel = adapter.nativeLabel || nativeSection.querySelector('[data-testid="sort-label"]');
    const label = nativeLabel?.cloneNode(true) || document.createElement("label");
    label.id = "lups-label";
    label.removeAttribute("data-testid");
    label.querySelector("p") ? label.querySelector("p").textContent = "Unit price" : label.textContent = "Unit price";
    const nativeButton = adapter.nativeButton || nativeSection.querySelector('[data-testid="menu-button"]');
    const button = nativeButton.cloneNode(true);
    button.id = "lups-menu-button";
    button.removeAttribute("data-testid");
    button.removeAttribute("aria-controls");
    button.setAttribute("aria-labelledby", "lups-label lups-menu-button");
    button.setAttribute("aria-expanded", "false");
    const buttonText = button.querySelector("p") || button.querySelector("span") || button;
    buttonText.id = "lups-menu-button-text";
    const nativeMenuList = adapter.nativeMenuList || nativeSection.querySelector('[data-testid="menu-list"]');
    const nativeMenuHost = nativeMenuList?.parentElement;
    const menuHost = document.createElement("div");
    menuHost.className = nativeMenuHost?.className || "";
    menuHost.id = "lups-menu-host";
    menuHost.hidden = true;
    menuHost.style.cssText = "position:absolute;z-index:2147483647;min-width:max-content;top:100%;right:0;";
    const menu = document.createElement("div");
    menu.id = "lups-menu";
    menu.className = nativeMenuList?.className || "";
    menu.setAttribute("aria-label", "Unit price sort");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-orientation", "vertical");
    menu.tabIndex = -1;
    menu.style.cssText = "opacity:1;visibility:visible;transform:none;max-height:min(70vh,560px);overflow-y:auto;";
    const nativeItem = nativeMenuList?.querySelector('[data-testid="menu-item"]');
    const nativeTick = nativeMenuList?.querySelector('[data-testid="menu-tick-icon"]');
    const select = document.createElement("select");
    select.id = "lups-mode";
    select.setAttribute("aria-hidden", "true");
    select.tabIndex = -1;
    select.hidden = true;
    function choose(value) {
      const option = OPTIONS.find(([key]) => key === value) || OPTIONS[0];
      select.value = option[0];
      buttonText.textContent = option[4];
      for (const item of menu.querySelectorAll("[data-lups-value]")) {
        const chosen = item.dataset.lupsValue === option[0];
        item.setAttribute("aria-checked", String(chosen));
        item.querySelector("[data-lups-tick]")?.toggleAttribute("hidden", !chosen);
      }
      menuHost.hidden = true;
      button.setAttribute("aria-expanded", "false");
      if (option[0] === "restore") onChange({ type: "restore" });
      else onChange({ type: "sort", dimension: option[2], direction: option[3] });
    }
    for (const [value, title, , , , detail] of OPTIONS) {
      select.add(new Option(`${title}: ${detail}`, value));
      const item = nativeItem?.cloneNode(true) || document.createElement("button");
      item.type = "button";
      item.id = `lups-menu-item-${value}`;
      item.removeAttribute("data-testid");
      item.dataset.lupsValue = value;
      item.setAttribute("role", "menuitemradio");
      item.tabIndex = -1;
      item.textContent = "";
      item.setAttribute("aria-label", `${title}, ${detail}`);
      const copy = document.createElement("span");
      copy.className = "lups-option-copy";
      const itemTitle = document.createElement("strong");
      itemTitle.className = "lups-option-title";
      itemTitle.textContent = title;
      const itemDetail = document.createElement("small");
      itemDetail.className = "lups-option-detail";
      itemDetail.textContent = detail;
      copy.append(itemTitle, itemDetail);
      const tick = makeTick(nativeTick);
      tick.removeAttribute("data-testid");
      tick.dataset.lupsTick = "";
      item.append(copy, tick);
      item.addEventListener("click", () => choose(value));
      menu.append(item);
    }
    select.value = activeValue(state2);
    select.addEventListener("change", () => choose(select.value));
    button.addEventListener("click", () => {
      const opening = menuHost.hidden;
      menuHost.hidden = !opening;
      button.setAttribute("aria-expanded", String(opening));
      if (opening) menu.querySelector(`[data-lups-value="${select.value}"]`)?.focus();
    });
    menu.addEventListener("keydown", (event) => {
      const items = [...menu.querySelectorAll("[data-lups-value]")];
      const index = items.indexOf(document.activeElement);
      if (event.key === "Escape") {
        menuHost.hidden = true;
        button.setAttribute("aria-expanded", "false");
        button.focus();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        items[(index + delta + items.length) % items.length].focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        items[0].focus();
      } else if (event.key === "End") {
        event.preventDefault();
        items.at(-1).focus();
      }
    });
    document.addEventListener("click", (event) => {
      if (!root.contains(event.target)) {
        menuHost.hidden = true;
        button.setAttribute("aria-expanded", "false");
      }
    });
    const status = document.createElement("output");
    status.id = "lups-status";
    status.setAttribute("aria-live", "polite");
    menuHost.append(menu);
    inner.append(label, button, menuHost, select, status);
    root.append(inner);
    (adapter.insert || ((control) => nativeSection.insertAdjacentElement("afterend", control)))(root);
    choose(activeValue(state2));
    return root;
  }
  function createControl(onChange, state2 = { dimension: "auto", direction: "asc", restored: true }, adapter = {}) {
    const template = document.createElement("section");
    const button = document.createElement("button");
    button.type = "button";
    const buttonText = document.createElement("span");
    button.append(buttonText);
    template.append(button);
    return createNativeControl(template, onChange, state2, {
      ...adapter,
      nativeButton: button,
      insert: (control) => document.body.append(control)
    });
  }
  function updateStatus(root, { dimension, sortable, incompatible, unknown, total, excluded = 0, restored = false }) {
    root.querySelector("#lups-status").textContent = restored ? `Website order restored for ${total} loaded products.` : `Sorted ${sortable} products by ${LABELS[dimension]}${dimension === "total" ? " (unit prices unavailable or manually selected)" : ""}. ${incompatible} incompatible; ${unknown} unknown${excluded ? `; ${excluded} excluded` : ""}. ${total} loaded products total.`;
  }
  function annotate(model) {
    const host = model.annotationHost || model.productCard || model.card;
    let note = host.querySelector("[data-lups-annotation]");
    if (!note) {
      note = document.createElement("div");
      note.setAttribute("data-lups-annotation", "");
      note.className = "lups-annotation";
      host.append(note);
    }
    if (Number.isFinite(model.normalizedUnitPrice)) {
      const explicit = model.source === "explicit-site-unit-price";
      const origin = explicit ? "retailer API" : "calculated from retailer API";
      note.dataset.source = explicit ? "retailer" : "calculated";
      note.textContent = `${model.normalizedUnitPrice.toFixed(2)} ${model.normalizedUnit} (${origin})`;
    } else {
      note.dataset.source = "unknown";
      note.textContent = model.source === "ambiguous" ? "Unit price ambiguous" : "Unit price unavailable";
    }
  }
  function injectStyles() {
    if (document.getElementById("lups-styles")) return;
    const style = document.createElement("style");
    style.id = "lups-styles";
    style.textContent = `
    #lups-control[data-lups-floating="true"]{position:fixed!important;z-index:2147483646!important;right:18px!important;bottom:18px!important;margin:0!important;color:#17221d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    #lups-control[data-lups-floating="true"]>div{position:relative!important;display:flex!important;align-items:center!important;gap:10px!important}
    #lups-label{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
    #lups-menu-button{box-sizing:border-box!important;display:inline-flex!important;align-items:center!important;justify-content:space-between!important;gap:10px!important;min-width:190px!important;min-height:42px!important;padding:9px 12px!important;border:1px solid #9eb9a9!important;border-radius:10px!important;background:linear-gradient(180deg,#f8fcf9 0%,#edf7f0 100%)!important;color:#155f45!important;box-shadow:0 1px 2px #163f2b14!important;font:600 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;white-space:nowrap!important;transition:border-color .15s ease,box-shadow .15s ease,background .15s ease!important}
    #lups-menu-button:hover{border-color:#438a6d!important;background:#e8f5ec!important;box-shadow:0 2px 5px #163f2b1f!important}
    #lups-menu-button[aria-expanded="true"]{border-color:#197454!important;background:#e4f3e9!important;box-shadow:0 0 0 3px #1b805326!important}
    #lups-menu-button-text{overflow:hidden!important;text-overflow:ellipsis!important}
    #lups-control[data-lups-floating="true"] #lups-status{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    #lups-control[data-lups-floating="true"] [data-lups-tick][hidden]{display:none!important}
    #lups-menu-host[hidden]{display:none!important}
    #lups-menu-host{box-sizing:border-box!important;top:auto!important;right:0!important;bottom:calc(100% + 8px)!important;width:min(350px,calc(100vw - 24px))!important;min-width:0!important}
    #lups-menu{box-sizing:border-box!important;width:100%!important;padding:8px!important;border:1px solid #d8e2dc!important;border-radius:14px!important;background:#fff!important;color:#17221d!important;box-shadow:0 18px 48px #14251d2e,0 3px 10px #14251d1f!important}
    #lups-menu [data-lups-value]{box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:space-between!important;gap:16px!important;width:100%!important;min-height:46px!important;padding:6px 10px!important;border:0!important;border-radius:9px!important;background:transparent!important;color:inherit!important;text-align:left!important;font-family:inherit!important}
    #lups-menu [data-lups-value]:hover,#lups-menu [data-lups-value]:focus-visible{background:#f0f7f2!important}
    #lups-menu [data-lups-value][aria-checked="true"]{background:#e4f3e9!important;color:#0e6245!important}
    #lups-menu [data-lups-value="auto-asc"],#lups-menu [data-lups-value="mass-asc"],#lups-menu [data-lups-value="volume-asc"],#lups-menu [data-lups-value="count-asc"],#lups-menu [data-lups-value="total-asc"]{margin-top:5px!important}
    .lups-option-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}
    .lups-option-title{font-size:14px;line-height:1.2;font-weight:650}
    .lups-option-detail{overflow:hidden;color:#607068;font-size:11.5px;line-height:1.25;font-weight:450;text-overflow:ellipsis;white-space:nowrap}
    #lups-menu [aria-checked="true"] .lups-option-detail{color:#39735e}
    #lups-menu [data-lups-tick]{flex:0 0 auto;color:#197454}
    #lups-control :focus-visible{outline:3px solid #1769aa;outline-offset:2px}
    .lups-annotation{box-sizing:border-box!important;display:block!important;width:max-content!important;max-width:100%!important;margin:6px 0!important;padding:4px 8px!important;border:1px solid #9bc9ae!important;border-radius:999px!important;background:#edf8ef!important;color:#184d27!important;font:650 12px/1.3 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important}
    .lups-annotation[data-source="calculated"]{border-color:#1769aa;background:#eef6fc;color:#164b72}.lups-annotation[data-source="unknown"]{border-color:#777;background:#f4f4f4;color:#555}
    @media(max-width:640px){#lups-control[data-lups-floating="true"]{right:10px!important;bottom:14px!important}#lups-menu-button{min-width:0!important;width:158px!important;min-height:40px!important;padding:8px 10px!important;font-size:13px!important}#lups-menu-host{position:fixed!important;right:8px!important;bottom:64px!important;width:calc(100vw - 16px)!important}#lups-menu{max-height:min(82vh,640px)!important}}
  `;
    document.head.append(style);
  }

  // src/retailers/loblaw/content.js
  var state = { dimension: "auto", direction: "asc", restored: true, observer: null, timer: null };
  var originalLocations = /* @__PURE__ */ new WeakMap();
  var apiProducts = /* @__PURE__ */ new Map();
  var apiScope = null;
  var apiRevision = 0;
  var debug = false;
  var log = (...args) => {
    if (debug) console.info("[Grocery Price Per Unit: Loblaw]", ...args);
  };
  function applyMode(value = "restore") {
    if (value === "restore") state.restored = true;
    else {
      const match = /^(auto|mass|volume|count|total)-(asc|desc)$/.exec(value);
      if (!match) return;
      [, state.dimension, state.direction] = match;
      state.restored = false;
    }
  }
  function extensionStorage() {
    return globalThis.browser?.storage || globalThis.chrome?.storage;
  }
  var API_SOURCE = "rcss-price-per-unit";
  var API_VERSION = 1;
  function normalizedQuery(value) {
    return typeof value === "string" ? value.trim().normalize("NFKC").replace(/\s+/g, " ").toLowerCase().slice(0, 256) || null : null;
  }
  function currentScope() {
    const url = new URL(location.href);
    const query = normalizedQuery(url.searchParams.get("search-bar"));
    return query ? `query:${query}` : `page:${url.pathname}${url.search}`;
  }
  function normalizeApiProduct(value, id) {
    if (!value || typeof value !== "object" || value.id !== id || !/^[a-zA-Z0-9._:-]+$/.test(id)) return null;
    const bounded = (input, maximum) => typeof input === "string" && input.length <= maximum ? input : null;
    const price = (input) => input === null || input === void 0 ? null : typeof input === "number" && Number.isFinite(input) && input >= 0 && input <= 1e6 ? input : NaN;
    const product = {
      id,
      name: bounded(value.name, 1500),
      packageSizing: bounded(value.packageSizing, 256),
      currentPrice: price(value.currentPrice),
      regularPrice: price(value.regularPrice),
      displayPrice: bounded(value.displayPrice, 80),
      weighted: typeof value.weighted === "boolean" ? value.weighted : null
    };
    return product.name && !Number.isNaN(product.currentPrice) && !Number.isNaN(product.regularPrice) ? product : null;
  }
  function ingestApiMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (message?.source !== API_SOURCE || message?.version !== API_VERSION || message?.type !== "api-products" || message.mode !== "snapshot" || !message.products || typeof message.products !== "object" || Array.isArray(message.products)) return;
    const query = normalizedQuery(message.context?.query);
    const scope = query ? `query:${query}` : `page:${message.context?.pagePath || ""}`;
    if (scope !== currentScope() || !Number.isSafeInteger(message.revision) || message.revision < apiRevision) return;
    const entries = Object.entries(message.products);
    if (entries.length > 500) return;
    apiProducts.clear();
    for (const [id, value] of entries) {
      const product = normalizeApiProduct(value, id);
      if (product) apiProducts.set(id, product);
    }
    apiScope = scope;
    apiRevision = message.revision;
    log("accepted API products", { products: apiProducts.size, revision: apiRevision, scope });
    schedule();
  }
  window.addEventListener("message", ingestApiMessage);
  window.postMessage({ source: API_SOURCE, version: API_VERSION, type: "api-products-request" }, location.origin);
  async function loadDefaultMode() {
    const storage = extensionStorage();
    if (!storage?.sync) return;
    try {
      const result = await storage.sync.get({ defaultSortMode: "restore" });
      applyMode(result.defaultSortMode);
    } catch (error) {
      log("Could not load extension settings", error);
    }
  }
  function ensureControl() {
    let control = document.getElementById("lups-control");
    if (control) return control;
    control = createControl((action) => {
      if (action.type === "restore") state.restored = true;
      if (action.type === "sort") {
        state.dimension = action.dimension;
        state.direction = action.direction;
        state.restored = false;
      }
      scan();
    }, state);
    if (!control) return null;
    if (!control.isConnected) document.body.append(control);
    return control;
  }
  function rememberLocations(models) {
    for (const model of models) {
      if (!originalLocations.has(model.card)) {
        originalLocations.set(model.card, { parent: model.card.parentElement, index: [...model.card.parentElement.children].indexOf(model.card) });
      }
    }
  }
  function consolidate(models, container) {
    rememberLocations(models);
    for (const model of models) if (model.card.parentElement !== container) container.append(model.card);
  }
  function restore(models, control) {
    for (const model of models) model.card.style.removeProperty("order");
    const groups = /* @__PURE__ */ new Map();
    for (const model of models) {
      const location2 = originalLocations.get(model.card);
      if (!location2?.parent?.isConnected) continue;
      if (!groups.has(location2.parent)) groups.set(location2.parent, []);
      groups.get(location2.parent).push({ card: model.card, index: location2.index });
    }
    for (const [parent, cards] of groups) {
      for (const { card } of cards.sort((a, b) => a.index - b.index)) parent.append(card);
    }
    updateStatus(control, { total: models.length, restored: true });
  }
  function scan() {
    const scope = currentScope();
    if (apiScope !== scope) {
      window.postMessage({ source: API_SOURCE, version: API_VERSION, type: "api-products-request" }, location.origin);
    }
    const grid = extractGrid(document, apiScope === scope ? apiProducts : null);
    if (!grid) return;
    const control = ensureControl();
    if (!control) return;
    for (const model of grid.models) model.card.dataset.lupsDataSource = model.dataSource;
    for (const model of grid.models) {
      if (model.dataSource === "api") annotate(model);
      else model.card.querySelector("[data-lups-annotation]")?.remove();
    }
    if (state.restored) return restore(grid.models, control);
    consolidate(grid.models, grid.container);
    const sorted = sortModels(grid.models, { dimension: state.dimension, direction: state.direction });
    sorted.items.forEach((model, index) => model.card.style.order = String(index));
    const sortable = grid.models.filter((m) => sorted.dimension === "total" ? Number.isFinite(m.currentPrice) : m.dimension === sorted.dimension && Number.isFinite(m.normalizedUnitPrice)).length;
    const incompatible = sorted.dimension === "total" ? 0 : grid.models.filter((m) => m.dimension && m.dimension !== sorted.dimension && Number.isFinite(m.normalizedUnitPrice)).length;
    const unknown = grid.models.length - sortable - incompatible;
    updateStatus(control, { dimension: sorted.dimension, sortable, incompatible, unknown, total: grid.models.length });
    log("scan", { dimension: sorted.dimension, sortable, incompatible, unknown });
  }
  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(scan, 180);
  }
  async function start() {
    if (!document.body || document.getElementById("lups-control")) return;
    await loadDefaultMode();
    injectStyles();
    scan();
    state.observer = new MutationObserver((records) => {
      if (records.every((record) => record.target.closest?.("#lups-control,[data-lups-annotation]"))) return;
      schedule();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    extensionStorage()?.onChanged?.addListener((changes, area) => {
      if (area !== "sync" || !changes.defaultSortMode) return;
      applyMode(changes.defaultSortMode.newValue);
      document.getElementById("lups-control")?.remove();
      schedule();
    });
    window.addEventListener("pagehide", () => {
      state.observer?.disconnect();
      window.removeEventListener("scroll", schedule, { capture: true });
      clearTimeout(state.timer);
    }, { once: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
