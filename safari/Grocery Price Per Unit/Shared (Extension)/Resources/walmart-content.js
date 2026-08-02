(() => {
  // src/retailers/walmart/content.js
  var Unit = class {
    constructor(id, unit, regexString, scaleToStandard, standardAmount, scaleToStandardUnit) {
      this.id = id;
      this.unit = unit;
      this.regexString = regexString;
      this.scaleToStandard = scaleToStandard;
      this.standardAmount = standardAmount;
      this.scaleToStandardUnit = scaleToStandardUnit;
    }
    get Id() {
      return this.id;
    }
    get Unit() {
      return this.unit;
    }
    get RegexString() {
      return this.regexString;
    }
    get ScaleToStandard() {
      return this.scaleToStandard;
    }
    get StandardAmount() {
      return this.standardAmount;
    }
    get ScaleToStandardUnit() {
      return this.scaleToStandardUnit;
    }
  };
  Unit.Kilogram = new Unit(0, "kg", "kg|kilogram|kilograms", 10, "100g", 1e3);
  Unit.Milliliter = new Unit(4, "ml", "ml|milliliter|milliliters|millilitre|millilitres", 0.01, "100ml", 1);
  Unit.FluidOunce = new Unit(8, "fl oz", "fl\\.?\\s*oz|fluid\\s*(?:ounces?|oz)", 1, "fl oz", 29.5735);
  Unit.Ounce = new Unit(3, "oz", "oz|ounce|ounces", 1, "oz", 28.3495);
  Unit.Pound = new Unit(2, "lb", "lbs?|pounds?", 1, "lb", 453.592);
  Unit.Count = new Unit(6, "ct", "ct|count|counts|ea|each|pack|packs|egg|eggs|bag|bags|sheet|sheets|roll|rolls|box|boxes|pod|pods|strip|strips|tablet|tablets|capsule|capsules", 1, "1ct");
  Unit.Load = new Unit(7, "load", "load|loads", 1, "1 load");
  Unit.Gram = new Unit(1, "g", "g|gram|grams", 0.01, "100g", 1);
  Unit.Liter = new Unit(5, "l", "l|liter|liters|litre|litres", 10, "100ml", 1e3);
  Unit.All = [
    Unit.Kilogram,
    Unit.Milliliter,
    Unit.FluidOunce,
    Unit.Ounce,
    Unit.Pound,
    Unit.Count,
    Unit.Load,
    Unit.Gram,
    Unit.Liter
  ];
  var numberRegexString = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
  var bulkUnitRegexString = (() => {
    let regexString = "(" + numberRegexString + ")\\s*x\\s*(" + numberRegexString + ")\\s*(";
    for (let i = 0; i < Unit.All.length; i++) {
      regexString += Unit.All[i].RegexString + "|";
    }
    regexString = regexString.slice(0, -1);
    regexString += ")(?![a-zA-Z])";
    return regexString;
  })();
  var processedSignatures = /* @__PURE__ */ new WeakMap();
  var processedStates = /* @__PURE__ */ new WeakMap();
  var apiProductsById = /* @__PURE__ */ new Map();
  var API_BRIDGE_SOURCE = "walmart-price-per-unit";
  var API_BRIDGE_VERSION = 1;
  var MAX_API_PRODUCTS = 500;
  var apiProductRevision = 0;
  var apiProductScope = null;
  function reportApiStatus(level, message, details) {
    try {
      const logger = console?.[level];
      if (typeof logger !== "function") return;
      if (details === void 0) logger.call(console, "[WPPU API]", message);
      else logger.call(console, "[WPPU API]", message, details);
    } catch (_error) {
    }
  }
  function boundedString(value, maxLength) {
    return typeof value === "string" && value.length <= maxLength ? value : null;
  }
  function boundedNumber(value, min = 0, max = 1e6) {
    return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
  }
  function normalizeApiUnitPrice(value) {
    if (typeof value === "string") return boundedString(value, 160);
    if (!value || typeof value !== "object") return null;
    const normalized = {
      price: boundedNumber(value.price),
      priceString: boundedString(value.priceString, 160)
    };
    return normalized.price === null && normalized.priceString === null ? null : normalized;
  }
  function normalizeApiProduct(value) {
    if (!value || typeof value !== "object") return null;
    const id = boundedString(value.id, 160);
    const name = boundedString(value.name, 1500);
    const price = value.price === null || value.price === void 0 ? null : boundedNumber(value.price);
    const averagePrice = value.averagePrice === null || value.averagePrice === void 0 ? null : boundedNumber(value.averagePrice);
    if (!id || !name || value.price !== null && value.price !== void 0 && price === null || value.averagePrice !== null && value.averagePrice !== void 0 && averagePrice === null || !/^[a-zA-Z0-9._:-]+$/.test(id)) return null;
    return {
      id,
      name,
      price,
      averagePrice,
      unitPrice: normalizeApiUnitPrice(value.unitPrice),
      variableOptions: typeof value.variableOptions === "boolean" ? value.variableOptions : null,
      currentVariantConfirmed: typeof value.currentVariantConfirmed === "boolean" ? value.currentVariantConfirmed : null,
      currentVariantName: boundedString(value.currentVariantName, 256),
      requestSequence: Number.isSafeInteger(value.requestSequence) && value.requestSequence >= 0 ? value.requestSequence : null
    };
  }
  function normalizeApiQuery(value) {
    const query = boundedString(value, 256)?.trim();
    return query ? query.normalize("NFKC").replace(/\s+/g, " ").toLowerCase() : null;
  }
  function safeApiPagePath(value) {
    if (value === null || value === void 0) return null;
    const pagePath = boundedString(value, 2048);
    if (!pagePath || !window.location?.origin) return null;
    try {
      const url = new URL(pagePath, window.location.origin);
      if (url.origin !== window.location.origin || !(url.hostname === "walmart.ca" || url.hostname.endsWith(".walmart.ca"))) return null;
      return `${url.pathname}${url.search}`;
    } catch (_error) {
      return null;
    }
  }
  function normalizeApiContext(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const context = {
      query: value.query === null ? null : normalizeApiQuery(value.query),
      page: Number.isSafeInteger(value.page) && value.page >= 0 && value.page <= 1e4 ? value.page : null,
      pageUrlAtRequest: safeApiPagePath(value.pageUrlAtRequest),
      pageUrlAtCapture: safeApiPagePath(value.pageUrlAtCapture)
    };
    if (context.query === null && context.pageUrlAtRequest === null && context.pageUrlAtCapture === null) return null;
    return context;
  }
  function currentApiPageContext() {
    try {
      const url = new URL(window.location.href);
      return {
        query: normalizeApiQuery(url.searchParams.get("q")),
        pagePath: `${url.pathname}${url.search}`
      };
    } catch (_error) {
      return { query: null, pagePath: null };
    }
  }
  function apiContextMatchesCurrentPage(context) {
    const current = currentApiPageContext();
    if (context.query !== null) return context.query === current.query;
    return current.pagePath !== null && (context.pageUrlAtCapture === current.pagePath || context.pageUrlAtRequest === current.pagePath);
  }
  function scopeForApiContext(context) {
    if (context.query !== null) return `query:${context.query}`;
    return `page:${context.pageUrlAtCapture || context.pageUrlAtRequest}`;
  }
  function currentApiScope() {
    const current = currentApiPageContext();
    if (current.query !== null) return `query:${current.query}`;
    return current.pagePath === null ? null : `page:${current.pagePath}`;
  }
  function apiProductForContainer(container) {
    const activeScope = currentApiScope();
    if (activeScope === null || apiProductScope !== activeScope) return null;
    const productId = container.getAttribute("data-item-id");
    return productId ? apiProductsById.get(productId) || null : null;
  }
  function ingestApiProductsMessage(event) {
    const message = event.data;
    if (!message || message.source !== API_BRIDGE_SOURCE || message.type !== "api-products") return false;
    if (event.source !== window || event.origin !== window.location?.origin) {
      reportApiStatus("warn", "rejected product message from an unexpected origin");
      return false;
    }
    if (!message || message.source !== API_BRIDGE_SOURCE || message.version !== API_BRIDGE_VERSION || message.type !== "api-products" || !["batch", "snapshot"].includes(message.mode) || !message.products || typeof message.products !== "object" || Array.isArray(message.products)) {
      reportApiStatus("warn", "rejected malformed product message");
      return false;
    }
    const context = normalizeApiContext(message.context);
    if (!context || !apiContextMatchesCurrentPage(context)) {
      reportApiStatus("debug", "ignored product message for a different search", {
        messageQuery: context?.query ?? null,
        currentQuery: currentApiPageContext().query,
        revision: message.revision
      });
      return false;
    }
    const revision = Number.isSafeInteger(message.revision) && message.revision >= 0 ? message.revision : 0;
    if (revision < apiProductRevision) {
      reportApiStatus("debug", "ignored an older product revision", {
        revision,
        activeRevision: apiProductRevision
      });
      return false;
    }
    const productIds = Object.keys(message.products);
    if (productIds.length > MAX_API_PRODUCTS) {
      reportApiStatus("warn", "rejected oversized product message", { products: productIds.length });
      return false;
    }
    const nextScope = scopeForApiContext(context);
    let changed = false;
    if (message.mode === "snapshot" || nextScope !== apiProductScope) {
      changed = apiProductsById.size > 0 || nextScope !== apiProductScope;
      apiProductsById.clear();
      apiProductScope = nextScope;
    }
    for (const productId of productIds) {
      const value = message.products[productId];
      const product = normalizeApiProduct(value);
      if (!product || product.id !== productId) continue;
      const previous = apiProductsById.get(product.id);
      if (previous && previous.requestSequence !== null && product.requestSequence !== null && previous.requestSequence > product.requestSequence) continue;
      if (JSON.stringify(previous) === JSON.stringify(product)) continue;
      apiProductsById.delete(product.id);
      apiProductsById.set(product.id, product);
      changed = true;
    }
    while (apiProductsById.size > MAX_API_PRODUCTS) apiProductsById.delete(apiProductsById.keys().next().value);
    apiProductRevision = Math.max(apiProductRevision, revision);
    reportApiStatus("info", "accepted sanitized product message", {
      mode: message.mode,
      revision,
      query: context.query,
      page: context.page,
      receivedProducts: productIds.length,
      cachedProducts: apiProductsById.size,
      changed
    });
    if (changed) processProducts(true, {
      mode: message.mode,
      revision,
      query: context.query,
      receivedProducts: productIds.length
    });
    return changed;
  }
  window.addEventListener("message", ingestApiProductsMessage);
  reportApiStatus("info", "isolated bridge ready; requesting captured product snapshot");
  window.postMessage?.({
    source: API_BRIDGE_SOURCE,
    version: API_BRIDGE_VERSION,
    type: "api-products-request"
  }, window.location?.origin || "*");
  function getUnit(unitText) {
    if (typeof unitText !== "string") return null;
    const normalized = unitText.trim().toLowerCase().replace(/\s+/g, " ");
    for (let i = 0; i < Unit.All.length; i++) {
      if (new RegExp(`^(?:${Unit.All[i].RegexString})$`, "i").test(normalized)) return Unit.All[i];
    }
    return null;
  }
  function parseWalmartPricePerUnitText(pricePerUnitText) {
    if (typeof pricePerUnitText !== "string") return null;
    const unitAliases = Unit.All.map((unit2) => unit2.RegexString).join("|");
    const match = pricePerUnitText.trim().match(new RegExp(
      `(?:\\$\\s*(${numberRegexString})|(${numberRegexString})\\s*\xA2)\\s*\\/\\s*(?:(${numberRegexString})\\s*)?(${unitAliases})(?![a-zA-Z])`,
      "i"
    ));
    if (!match) return null;
    let value = parseFloat(match[1] || match[2]);
    if (match[2]) value = value / 100;
    const amount = match[3] ? parseFloat(match[3]) : 1;
    const unit = match[4].toLowerCase();
    const parsedUnit = getUnit(unit);
    if (!parsedUnit) return null;
    return {
      value,
      amount,
      unit: parsedUnit,
      text: `$${value.toFixed(2)}/${amount}${unit}`
    };
  }
  function extractApiPricePerUnit(product) {
    const value = product?.unitPrice;
    if (typeof value === "string") return parseWalmartPricePerUnitText(value);
    return parseWalmartPricePerUnitText(value?.priceString || "");
  }
  function extractPromotion(container) {
    const promoEl = container.querySelector('[data-testid="tag-leading-badge"]');
    if (!promoEl) return null;
    const promoText = promoEl.textContent.trim().toLowerCase();
    const match = promoText.match(/(\d+)\s*for\s*\$?(\d+(\.\d+)?)/i);
    if (!match) return null;
    return {
      qty: parseInt(match[1], 10),
      total: parseFloat(match[2])
    };
  }
  function extractCoupon(container) {
    const couponEl = container.querySelector('[data-testid="product-promo-banner"]');
    if (!couponEl) return null;
    const couponText = couponEl.textContent.trim().toLowerCase();
    const match = couponText.match(/\$([\d\.]+)\s*coupon/i);
    if (!match) return null;
    return parseFloat(match[1]);
  }
  function dimensionForUnit(unit) {
    switch (unit) {
      case Unit.Gram:
      case Unit.Kilogram:
      case Unit.Ounce:
      case Unit.Pound:
        return "mass";
      case Unit.Milliliter:
      case Unit.Liter:
      case Unit.FluidOunce:
        return "volume";
      case Unit.Count:
      case Unit.Load:
        return "count";
      default:
        return "unknown";
    }
  }
  function amountInBaseUnit(amount, unit) {
    if (!Number.isFinite(amount) || amount <= 0 || !unit) return null;
    if (unit === Unit.Count || unit === Unit.Load) return amount;
    if (!Number.isFinite(unit.ScaleToStandardUnit)) return null;
    return amount * unit.ScaleToStandardUnit;
  }
  function collectUnitCandidates(title) {
    const aliases = Unit.All.map((unit) => unit.RegexString).join("|");
    const regex = new RegExp(`(${numberRegexString})\\s*(${aliases})(?![a-zA-Z])`, "gi");
    const candidates = [];
    let match;
    while ((match = regex.exec(title)) !== null) {
      const amount = parseFloat(match[1]);
      const unit = getUnit(match[2].toLowerCase());
      if (Number.isFinite(amount) && amount > 0 && unit) {
        candidates.push({
          amount,
          unit,
          unitText: match[2].toLowerCase(),
          index: match.index,
          end: regex.lastIndex
        });
      }
      if (match[0].length === 0) regex.lastIndex += 1;
    }
    return candidates;
  }
  function packageDetailsAfter(title, candidate) {
    const suffix = title.slice(candidate.end);
    const packagePatterns = [
      new RegExp(`^\\s*\\/\\s*units?\\b[\\s,;|/-]*(${numberRegexString})\\s*units?\\s*\\/\\s*case\\b`, "i"),
      new RegExp(`^[\\s,;|/()-]*(${numberRegexString})\\s*units?\\s*\\/\\s*case\\b`, "i")
    ];
    for (const regex of packagePatterns) {
      const match = suffix.match(regex);
      const multiplier = match ? parseFloat(match[1]) : 1;
      if (Number.isFinite(multiplier) && multiplier > 1) return { multiplier };
    }
    const packMatch = suffix.match(new RegExp(`^[\\s,;|/()-]*(${numberRegexString})\\s*(?:-\\s*)?packs?\\b`, "i"));
    const packCount = packMatch ? parseFloat(packMatch[1]) : 1;
    const packageContext = title.slice(0, candidate.index);
    if (Number.isFinite(packCount) && packCount > 1 && packCount <= 4 && /\b(?:bottles?|jars?|shakers?|pouches?|bags?|boxes?|cans?|tubs?|cartons?|packets?)\b/i.test(packageContext)) {
      return { multiplier: packCount };
    }
    const countMatch = suffix.match(new RegExp(`^[\\s,;|/()-]*(${numberRegexString})\\s*(?:-\\s*)?(?:ct|counts?)\\b`, "i"));
    const count = countMatch ? parseFloat(countMatch[1]) : 1;
    if (Number.isFinite(count) && count > 1) {
      const amountText = String(candidate.amount).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const unitText = candidate.unitText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const corroboration = new RegExp(`\\b${count}\\s*c\\s*${amountText}\\s*${unitText}\\b`, "i");
      if (corroboration.test(title)) return { multiplier: count };
    }
    return { multiplier: 1 };
  }
  function preferredPhysicalCandidates(candidates, preferredDimension) {
    let physical = candidates.filter((candidate) => candidate.unit !== Unit.Count && candidate.unit !== Unit.Load);
    if (preferredDimension === "mass" || preferredDimension === "volume") {
      const matching = physical.filter((candidate) => dimensionForUnit(candidate.unit) === preferredDimension);
      if (matching.length) physical = matching;
    }
    const withoutOunces = physical.filter((candidate) => candidate.unit !== Unit.Ounce);
    if (withoutOunces.length) physical = withoutOunces;
    const dimensions = new Set(physical.map((candidate) => dimensionForUnit(candidate.unit)).filter((dimension) => dimension !== "unknown"));
    if (dimensions.size > 1) return [];
    const metric = physical.filter(
      (candidate) => candidate.unit === Unit.Gram || candidate.unit === Unit.Kilogram || candidate.unit === Unit.Milliliter || candidate.unit === Unit.Liter
    );
    return metric.length ? metric : physical;
  }
  function candidateLooksLikeClaim(title, candidate) {
    const before = title.slice(Math.max(0, candidate.index - 36), candidate.index);
    const after = title.slice(candidate.end, candidate.end + 44);
    const claim = "(?:protein|sodium|sugar|fat|fibre|fiber|carbohydrates?|calcium|iron|caffeine|dosage|strength|capacity)";
    return new RegExp(`\\b${claim}\\s*$`, "i").test(before) || new RegExp(`^\\s*(?:of\\s+(?:[a-z-]+\\s+){0,2})?${claim}\\b`, "i").test(after) || /\b(?:serving(?:\s+size)?|dose)\s*$/i.test(before) || /^\s*(?:per\s+)?(?:serving|dose)\b/i.test(after);
  }
  function candidatesAreEquivalentMeasurement(title, first, second) {
    const firstAmount = amountInBaseUnit(first.amount, first.unit);
    const secondAmount = amountInBaseUnit(second.amount, second.unit);
    if (!(firstAmount > 0) || !(secondAmount > 0)) return false;
    const relativeDifference = Math.abs(firstAmount - secondAmount) / Math.max(firstAmount, secondAmount);
    if (relativeDifference > 0.04) return false;
    const separator = title.slice(first.end, second.index);
    return /^\s*(?:\/|\(|\[)\s*$/i.test(separator);
  }
  function extractUnitFromTitle(sourceTitle, preferredDimension = null) {
    if (typeof sourceTitle !== "string" || !sourceTitle.trim()) return null;
    const title = sourceTitle.toLowerCase();
    const bulkMatch = title.match(new RegExp(bulkUnitRegexString, "i"));
    let bulkUnitObj = null;
    if (bulkMatch) {
      const multiplier = parseFloat(bulkMatch[1]);
      const amount = parseFloat(bulkMatch[2]);
      const unitText = bulkMatch[3].toLowerCase();
      const unit = getUnit(unitText);
      if (unit) {
        bulkUnitObj = {
          amount: amount * multiplier,
          unit,
          packageMultiplier: multiplier
        };
        if (unit === Unit.Load) return bulkUnitObj;
      }
    }
    const candidates = collectUnitCandidates(title);
    const loads = candidates.filter((candidate) => candidate.unit === Unit.Load && candidate.amount > 0);
    if (loads.length) {
      return {
        amount: loads[loads.length - 1].amount,
        unit: Unit.Load
      };
    }
    if (bulkUnitObj) return bulkUnitObj;
    const physical = preferredPhysicalCandidates(candidates, preferredDimension).filter((candidate) => !candidateLooksLikeClaim(title, candidate));
    if (physical.length) {
      const dimension = dimensionForUnit(physical[0].unit);
      const comboCandidates = physical.filter((candidate) => dimensionForUnit(candidate.unit) === dimension);
      if (/\bcombo\s*(?:pack|kit|set)?\b/i.test(title) && comboCandidates.length > 1) {
        const distinctComboCandidates = comboCandidates.filter(
          (candidate, index, all) => index === 0 || !candidatesAreEquivalentMeasurement(title, all[index - 1], candidate)
        );
        const totalBaseAmount = distinctComboCandidates.reduce((total, candidate) => total + (amountInBaseUnit(candidate.amount, candidate.unit) || 0), 0);
        const unit = comboCandidates[0].unit;
        if (distinctComboCandidates.length > 1 && totalBaseAmount > 0 && Number.isFinite(unit.ScaleToStandardUnit)) {
          return {
            amount: totalBaseAmount / unit.ScaleToStandardUnit,
            unit,
            packageMultiplier: distinctComboCandidates.length,
            isComposite: true
          };
        }
      }
      const ranked = physical.map((candidate) => {
        const packageDetails = packageDetailsAfter(title, candidate);
        return {
          ...candidate,
          packageMultiplier: packageDetails.multiplier
        };
      }).sort(
        (a, b) => b.packageMultiplier - a.packageMultiplier || b.index - a.index
      );
      const selected = ranked[0];
      return {
        amount: selected.amount * selected.packageMultiplier,
        unit: selected.unit,
        packageMultiplier: selected.packageMultiplier
      };
    }
    const counts = candidates.filter((candidate) => candidate.unit === Unit.Count && candidate.amount > 1);
    if (!counts.length) return null;
    const count = counts[counts.length - 1];
    return {
      amount: count.amount,
      unit: Unit.Count
    };
  }
  function isUnambiguousVariantUnit(sourceTitle, unitObj) {
    if (typeof sourceTitle !== "string" || !unitObj) return false;
    if (unitObj.isComposite) return true;
    const dimension = dimensionForUnit(unitObj.unit);
    if (dimension === "unknown") return false;
    const title = sourceTitle.toLowerCase();
    const candidates = collectUnitCandidates(title).filter(
      (candidate) => dimensionForUnit(candidate.unit) === dimension && !candidateLooksLikeClaim(title, candidate)
    );
    if (candidates.length === 0) return false;
    if (candidates.length === 1) return true;
    const amounts = candidates.map((candidate) => amountInBaseUnit(candidate.amount, candidate.unit));
    if (amounts.some((amount) => !(amount > 0))) return false;
    const reference = amounts[0];
    return amounts.every((amount) => Math.abs(amount - reference) / Math.max(amount, reference) <= 0.04);
  }
  function resolveVariableOptionUnit(apiProduct, sourceTitle, unitObj) {
    if (isUnambiguousVariantUnit(sourceTitle, unitObj)) return unitObj;
    if (apiProduct?.currentVariantConfirmed !== true || !apiProduct.currentVariantName) return null;
    const currentVariantUnit = extractUnitFromTitle(apiProduct.currentVariantName);
    return isUnambiguousVariantUnit(apiProduct.currentVariantName, currentVariantUnit) ? currentVariantUnit : null;
  }
  function pricePerStandardUnit(price, unitObj) {
    if (!Number.isFinite(price) || price < 0 || !unitObj || !Number.isFinite(unitObj.amount) || unitObj.amount <= 0 || !Number.isFinite(unitObj.unit?.ScaleToStandard)) return null;
    return price / (unitObj.amount * unitObj.unit.ScaleToStandard);
  }
  function convertUnitObject(unitObj, preferredUnit) {
    if (!unitObj || !preferredUnit || preferredUnit === unitObj.unit) return unitObj ? { ...unitObj } : null;
    if (dimensionForUnit(unitObj.unit) !== dimensionForUnit(preferredUnit)) return { ...unitObj };
    const baseAmount = amountInBaseUnit(unitObj.amount, unitObj.unit);
    if (!(baseAmount > 0) || !(preferredUnit.ScaleToStandardUnit > 0)) return { ...unitObj };
    return {
      ...unitObj,
      amount: baseAmount / preferredUnit.ScaleToStandardUnit,
      unit: preferredUnit
    };
  }
  function clearSortModel(container) {
    container.querySelector(".price-per-unit-info")?.remove();
    delete container.dataset.ppuSortValue;
    delete container.dataset.ppuSortDimension;
    delete container.dataset.ppuSortUnit;
  }
  function showPricePerUnit(container, price, unitObj, _promo, _couponValue, walmartPricePerUnit) {
    const hasPackageBasis = Number.isFinite(price) && price >= 0 && unitObj;
    if (!hasPackageBasis && !walmartPricePerUnit) {
      clearSortModel(container);
      return;
    }
    const usedWalmartPPU = Boolean(walmartPricePerUnit);
    if (usedWalmartPPU) {
      price = walmartPricePerUnit.value;
      unitObj = { amount: walmartPricePerUnit.amount, unit: walmartPricePerUnit.unit };
    } else if (hasPackageBasis) {
      unitObj = { ...unitObj };
    } else {
      clearSortModel(container);
      return;
    }
    const preferredUnit = getPreferredUnit(unitObj);
    unitObj = convertUnitObject(unitObj, preferredUnit);
    let infoDiv = container.querySelector(".price-per-unit-info");
    if (!infoDiv) {
      infoDiv = document.createElement("div");
    } else {
      while (infoDiv.firstChild) {
        infoDiv.removeChild(infoDiv.firstChild);
      }
    }
    infoDiv.className = "price-per-unit-info lups-annotation";
    infoDiv.setAttribute("data-lups-annotation", "");
    const pricePerUnit = pricePerStandardUnit(price, unitObj);
    if (!Number.isFinite(pricePerUnit)) {
      clearSortModel(container);
      return;
    }
    const sortable = normalizePriceForSorting(pricePerUnit, unitObj.unit);
    if (sortable) {
      container.dataset.ppuSortValue = String(sortable.value);
      container.dataset.ppuSortDimension = sortable.dimension;
      container.dataset.ppuSortUnit = sortable.unit;
      infoDiv.dataset.source = usedWalmartPPU ? "retailer" : "calculated";
      infoDiv.textContent = `${sortable.value.toFixed(2)} ${sortable.unit.replace("CAD", "$")} (${usedWalmartPPU ? "retailer API" : "calculated from retailer API"})`;
    } else {
      delete container.dataset.ppuSortValue;
      delete container.dataset.ppuSortDimension;
      delete container.dataset.ppuSortUnit;
    }
    const priceEl = container.querySelector('[data-automation-id="product-price"]');
    if (priceEl && priceEl.parentNode) {
      priceEl.parentNode.insertBefore(infoDiv, priceEl.nextSibling);
    } else {
      container.prepend(infoDiv);
    }
    return pricePerUnit;
  }
  function normalizePriceForSorting(pricePerUnit, unit) {
    if (!Number.isFinite(pricePerUnit) || pricePerUnit < 0 || !unit) return null;
    switch (unit) {
      case Unit.Gram:
      case Unit.Kilogram:
        return { value: pricePerUnit * 10, dimension: "mass", unit: "CAD/kg" };
      case Unit.Pound:
        return { value: pricePerUnit / 0.453592, dimension: "mass", unit: "CAD/kg" };
      case Unit.Ounce:
        return { value: pricePerUnit / 0.0283495, dimension: "mass", unit: "CAD/kg" };
      case Unit.Milliliter:
      case Unit.Liter:
        return { value: pricePerUnit * 10, dimension: "volume", unit: "CAD/L" };
      case Unit.FluidOunce:
        return { value: pricePerUnit / 0.0295735, dimension: "volume", unit: "CAD/L" };
      case Unit.Count:
      case Unit.Load:
        return { value: pricePerUnit, dimension: "count", unit: "CAD/item" };
      default:
        return null;
    }
  }
  function getPreferredUnit(unitObj) {
    let preferredUnit = null;
    switch (unitObj.unit) {
      case Unit.Gram:
      case Unit.Kilogram:
      case Unit.Ounce:
      case Unit.Pound: {
        preferredUnit = Unit.Kilogram;
        break;
      }
      case Unit.Liter:
      case Unit.Milliliter:
      case Unit.FluidOunce: {
        preferredUnit = Unit.Liter;
        break;
      }
      case Unit.Load: {
        preferredUnit = Unit.Load;
        break;
      }
      default: {
        preferredUnit = Unit.Count;
        break;
      }
    }
    return preferredUnit;
  }
  function productSourceSignature(container, apiProduct = null) {
    const text = (selector) => container.querySelector(selector)?.textContent?.trim() || "";
    return JSON.stringify([
      container.getAttribute("data-item-id") || "",
      text('[data-testid="tag-leading-badge"]'),
      text('[data-testid="product-promo-banner"]'),
      apiProduct ? [
        apiProduct.id,
        apiProduct.name,
        apiProduct.price,
        apiProduct.averagePrice,
        apiProduct.unitPrice,
        apiProduct.variableOptions,
        apiProduct.currentVariantConfirmed,
        apiProduct.currentVariantName,
        apiProduct.requestSequence
      ] : null
    ]);
  }
  function extensionStateSignature(container) {
    const annotation = container.querySelector(".price-per-unit-info");
    return JSON.stringify([
      Boolean(annotation),
      annotation?.textContent || "",
      container.dataset.ppuTotalPrice || "",
      container.dataset.ppuSortValue || "",
      container.dataset.ppuSortDimension || "",
      container.dataset.ppuSortUnit || ""
    ]);
  }
  function processProducts(isForced = false, apiReport = null) {
    const productContainers = document.querySelectorAll("[data-item-id]");
    const scan = {
      renderedCards: 0,
      apiCards: 0,
      missingApiCards: 0,
      sortableCards: 0,
      errors: 0
    };
    productContainers.forEach((container) => {
      try {
        const productId = container.getAttribute("data-item-id");
        if (!productId) return;
        if (getComputedStyle(container).display === "none") {
          clearSortModel(container);
          delete container.dataset.ppuTotalPrice;
          delete container.dataset.ppuProcessingError;
          processedSignatures.delete(container);
          processedStates.delete(container);
          delete container.dataset.ppuDataSource;
          return;
        }
        scan.renderedCards += 1;
        const apiProduct = apiProductForContainer(container);
        const signature = productSourceSignature(container, apiProduct);
        if (!isForced && processedSignatures.get(container) === signature && processedStates.get(container) === extensionStateSignature(container)) return;
        if (!apiProduct) {
          clearSortModel(container);
          delete container.dataset.ppuTotalPrice;
          delete container.dataset.ppuDataSource;
          delete container.dataset.ppuProcessingError;
          processedSignatures.set(container, signature);
          processedStates.set(container, extensionStateSignature(container));
          scan.missingApiCards += 1;
          return;
        }
        scan.apiCards += 1;
        const price = apiProduct.price;
        const sortableTotalPrice = Number.isFinite(price) ? price : apiProduct.averagePrice;
        if (Number.isFinite(sortableTotalPrice) && sortableTotalPrice >= 0) {
          container.dataset.ppuTotalPrice = String(sortableTotalPrice);
        } else delete container.dataset.ppuTotalPrice;
        const promo = extractPromotion(container);
        const couponValue = extractCoupon(container);
        const walmartPricePerUnit = extractApiPricePerUnit(apiProduct);
        const productTitle = apiProduct.name;
        let unitObj = extractUnitFromTitle(productTitle, dimensionForUnit(walmartPricePerUnit?.unit));
        if (apiProduct.variableOptions === true) {
          unitObj = resolveVariableOptionUnit(apiProduct, productTitle, unitObj);
        }
        container.dataset.ppuDataSource = "api";
        showPricePerUnit(container, price, unitObj, promo, couponValue, walmartPricePerUnit);
        processedSignatures.set(container, signature);
        processedStates.set(container, extensionStateSignature(container));
        if (container.dataset.ppuSortDimension && container.dataset.ppuSortValue) scan.sortableCards += 1;
        delete container.dataset.ppuProcessingError;
      } catch (error) {
        container.dataset.ppuProcessingError = String(error?.message || error).slice(0, 160);
        processedSignatures.delete(container);
        processedStates.delete(container);
        scan.errors += 1;
        reportApiStatus("error", "failed to process a product card", {
          productId: container.getAttribute("data-item-id") || null,
          message: String(error?.message || error).slice(0, 240)
        });
      }
    });
    window.dispatchEvent(new CustomEvent("ppu-products-updated"));
    if (apiReport) {
      reportApiStatus("info", "applied product data to rendered cards", {
        ...apiReport,
        cachedApiProducts: apiProductsById.size,
        totalCardNodes: productContainers.length,
        ...scan
      });
    }
  }
  processProducts();
  var productScanTimer;
  function scheduleProductScan() {
    clearTimeout(productScanTimer);
    productScanTimer = setTimeout(() => processProducts(), 150);
  }
  var productObserver = new MutationObserver((mutations) => {
    const extensionOnly = mutations.every(
      (mutation) => mutation.target.closest?.("#ppu-sort-control, .price-per-unit-info, .ppu-walmart-icon")
    );
    if (!extensionOnly) scheduleProductScan();
  });
  productObserver.observe(document.body, {
    attributes: true,
    attributeFilter: [
      "class",
      "hidden",
      "data-item-id",
      "data-ppu-total-price",
      "data-ppu-sort-value",
      "data-ppu-sort-dimension",
      "data-ppu-sort-unit"
    ],
    childList: true,
    characterData: true,
    subtree: true
  });
  window.addEventListener("scroll", scheduleProductScan, { passive: true });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "unitPreferenceChanged") {
      processProducts(true);
    }
  });
})();
