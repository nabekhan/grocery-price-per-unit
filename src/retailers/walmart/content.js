import { formatUnitPrice, speakUnitPrice } from '../../ui/format.js';
import { MAX_RENDERED_CARDS, publishApiScanState } from './scan-state.js';
import { claimRuntimeInstall } from '../../runtime/install.js';
import { areOnlyOwnedMutations } from '../../runtime/mutations.js';
import { createScanScheduler } from '../../runtime/retailer-lifecycle.js';

/*!
 * Walmart card annotator. Scope-checked API/cache records join rendered cards
 * through stable product IDs; rendered price text is never a trusted input.
 * Frozen per-card models are published through the bundle-private WeakMap for
 * sorting, with bounded scans and reversible annotations.
 */

// Capture collection operations before retailer scripts can monkey-patch the
// page realm. The userscript deliberately shares that realm at document-start;
// trusted API/cache reads must not dispatch through later mutable prototypes.
const NativeMap = Map;
const mapGet = Function.call.bind(Map.prototype.get);
const mapSet = Function.call.bind(Map.prototype.set);
const mapDelete = Function.call.bind(Map.prototype.delete);
const mapClear = Function.call.bind(Map.prototype.clear);
const mapKeys = Function.call.bind(Map.prototype.keys);
const mapSize = Function.call.bind(Object.getOwnPropertyDescriptor(Map.prototype, 'size').get);
const mapIteratorNext = Function.call.bind(Object.getPrototypeOf(new Map().keys()).next);
const weakMapGet = Function.call.bind(WeakMap.prototype.get);
const weakMapSet = Function.call.bind(WeakMap.prototype.set);
const weakMapDelete = Function.call.bind(WeakMap.prototype.delete);
const setAdd = Function.call.bind(Set.prototype.add);
const setDelete = Function.call.bind(Set.prototype.delete);
const setValues = Function.call.bind(Set.prototype.values);
const setIteratorNext = Function.call.bind(Object.getPrototypeOf(new Set().values()).next);

// This script runs on walmart.ca and extracts price, unit, and calculates price per unit
class Unit {
    constructor(id, unit, regexString, scaleToStandard, standardAmount, scaleToStandardUnit) {
        this.id = id;
        this.unit = unit;
        this.regexString = regexString;
        this.scaleToStandard = scaleToStandard;
        this.standardAmount = standardAmount;
        this.scaleToStandardUnit = scaleToStandardUnit;
    }

    get Id() { return this.id; }
    get Unit() { return this.unit; }
    get RegexString() { return this.regexString; }
    get ScaleToStandard() { return this.scaleToStandard; }
    get StandardAmount() { return this.standardAmount; }
    get ScaleToStandardUnit() { return this.scaleToStandardUnit; }
}

Unit.Kilogram = new Unit(0, "kg", "kg|kilogram|kilograms", 10, "100g", 1000);
Unit.Milliliter = new Unit(4, "ml", "ml|milliliter|milliliters|millilitre|millilitres", 0.01, "100ml", 1);
Unit.FluidOunce = new Unit(8, "fl oz", "fl\\.?\\s*oz|fluid\\s*(?:ounces?|oz)", 1, "fl oz", 29.5735);
Unit.Ounce = new Unit(3, "oz", "oz|ounce|ounces", 1, "oz", 28.3495);
Unit.Pound = new Unit(2, "lb", "lbs?|pounds?", 1, "lb", 453.592);
Unit.Count = new Unit(6, "ct", "ct|count|counts|ea|each|pack|packs|egg|eggs|bag|bags|sheet|sheets|roll|rolls|box|boxes|pod|pods|strip|strips|tablet|tablets|capsule|capsules", 1, "1ct");
Unit.Load = new Unit(7, "load", "load|loads", 1, "1 load");
Unit.Gram = new Unit(1, "g", "g|gram|grams", 0.01, "100g", 1);
Unit.Liter = new Unit(5, "l", "l|liter|liters|litre|litres", 10, "100ml", 1000);

// unit with 2 characters must be placed at the top
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

const numberRegexString = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";

const bulkUnitRegexString = (() => {
    let regexString = "(" + numberRegexString + ")\\s*x\\s*(" + numberRegexString + ")\\s*(";
    for (let i = 0; i < Unit.All.length; i++) {
        regexString += Unit.All[i].RegexString + "|";
    }
    regexString = regexString.slice(0, -1);
    regexString += ")(?![a-zA-Z])";
    return regexString;
})();

const processedSignatures = new WeakMap();
const processedStates = new WeakMap();
const managedProductContainers = new Set();
const apiProductsById = new NativeMap();
const API_BRIDGE_SOURCE = 'walmart-price-per-unit';
const API_BRIDGE_VERSION = 2;
const isProductArray = Array.isArray;
const MAX_API_PRODUCTS = 500;
const MAX_API_REVISION = 1_000_000;
const MAX_API_REVISION_ADVANCE = 10_000;
let apiProductRevision = 0;
let apiProductScope = null;
let apiMessageGeneration = 0;
let lifecycle = null;

function reportApiStatus(level, message, details) {
    try {
        const logger = console?.[level];
        if (typeof logger !== 'function') return;
        if (details === undefined) logger.call(console, '[WPPU API]', message);
        else logger.call(console, '[WPPU API]', message, details);
    } catch (_error) {
        // Diagnostics must never affect product processing.
    }
}

function boundedString(value, maxLength) {
    return typeof value === 'string' && value.length <= maxLength ? value : null;
}

function boundedPositiveNumber(value, max = 1_000_000) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max ? value : null;
}

function normalizeApiUnitPrice(value) {
    if (typeof value === 'string') return boundedString(value, 160);
    if (!value || typeof value !== 'object') return null;
    const rawPrice = value.price;
    const rawPriceString = value.priceString;
    const normalized = {
        price: boundedPositiveNumber(rawPrice),
        priceString: boundedString(rawPriceString, 160)
    };
    return normalized.price === null && normalized.priceString === null ? null : normalized;
}

function normalizeApiProduct(value) {
    if (!value || typeof value !== 'object') return null;
    const rawId = value.id;
    const rawName = value.name;
    const rawPrice = value.price;
    const rawAveragePrice = value.averagePrice;
    const rawUnitPrice = value.unitPrice;
    const rawVariableOptions = value.variableOptions;
    const rawCurrentVariantConfirmed = value.currentVariantConfirmed;
    const rawCurrentVariantName = value.currentVariantName;
    const rawRequestSequence = value.requestSequence;
    const id = boundedString(rawId, 160);
    const name = boundedString(rawName, 1_500);
    const price = rawPrice === null || rawPrice === undefined ? null : boundedPositiveNumber(rawPrice);
    const averagePrice = rawAveragePrice === null || rawAveragePrice === undefined
        ? null
        : boundedPositiveNumber(rawAveragePrice);
    if (!id || !name || (rawPrice !== null && rawPrice !== undefined && price === null) ||
        (rawAveragePrice !== null && rawAveragePrice !== undefined && averagePrice === null) ||
        !/^[a-zA-Z0-9._:-]+$/.test(id)) return null;
    return {
        id,
        name,
        price,
        averagePrice,
        unitPrice: normalizeApiUnitPrice(rawUnitPrice),
        variableOptions: typeof rawVariableOptions === 'boolean' ? rawVariableOptions : null,
        currentVariantConfirmed: typeof rawCurrentVariantConfirmed === 'boolean' ? rawCurrentVariantConfirmed : null,
        currentVariantName: boundedString(rawCurrentVariantName, 256),
        requestSequence: Number.isSafeInteger(rawRequestSequence) && rawRequestSequence >= 0
            ? rawRequestSequence
            : null
    };
}

function normalizeApiQuery(value) {
    const query = boundedString(value, 256)?.trim();
    return query ? query.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase() : null;
}

function normalizeApiStoreId(value) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
    return boundedString(value, 80)?.trim().toLowerCase() || null;
}

function safeApiPagePath(value) {
    if (value === null || value === undefined) return null;
    const pagePath = boundedString(value, 2_048);
    if (!pagePath || !window.location?.origin) return null;
    try {
        const url = new URL(pagePath, window.location.origin);
        if (url.origin !== window.location.origin ||
            !(url.hostname === 'walmart.ca' || url.hostname.endsWith('.walmart.ca'))) return null;
        return `${url.pathname}${url.search}`;
    } catch (_error) {
        return null;
    }
}

function apiPageIdentity(value) {
    const pagePath = safeApiPagePath(value);
    if (pagePath === null) return null;
    const url = new URL(pagePath, window.location.origin);
    const parameters = [...url.searchParams.entries()]
        .filter(([key]) => !/^(?:q|page)$/i.test(key))
        .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
            leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    const suffix = parameters.map(([key, item]) => `${encodeURIComponent(key)}=${encodeURIComponent(item)}`).join('&');
    return `${url.pathname.replace(/\/$/, '')}${suffix ? `?${suffix}` : ''}`;
}

function normalizeApiContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const rawQuery = value.query;
    const rawPage = value.page;
    const rawStoreId = value.storeId;
    const rawPageUrlAtRequest = value.pageUrlAtRequest;
    const rawPageUrlAtCapture = value.pageUrlAtCapture;
    const context = {
        query: rawQuery === null ? null : normalizeApiQuery(rawQuery),
        page: Number.isSafeInteger(rawPage) && rawPage >= 0 && rawPage <= 10_000 ? rawPage : null,
        storeId: normalizeApiStoreId(rawStoreId),
        pageUrlAtRequest: safeApiPagePath(rawPageUrlAtRequest),
        pageUrlAtCapture: safeApiPagePath(rawPageUrlAtCapture)
    };
    context.pageIdentity = apiPageIdentity(context.pageUrlAtRequest || context.pageUrlAtCapture);
    if (context.query === null && context.pageUrlAtRequest === null && context.pageUrlAtCapture === null) return null;
    return context;
}

function currentApiPageContext() {
    try {
        const url = new URL(window.location.href);
        let storeId = null;
        for (const key of ['store', 'storeId', 'store_id']) {
            storeId = normalizeApiStoreId(url.searchParams.get(key));
            if (storeId) break;
        }
        return {
            query: normalizeApiQuery(url.searchParams.get('q')),
            storeId,
            pagePath: `${url.pathname}${url.search}`,
            pageIdentity: apiPageIdentity(`${url.pathname}${url.search}`)
        };
    } catch (_error) {
        return { query: null, pagePath: null };
    }
}

function apiContextMatchesCurrentPage(context) {
    const current = currentApiPageContext();
    if (context.query !== null) return context.query === current.query
        && (current.storeId === null || context.storeId === current.storeId)
        && context.pageIdentity !== null && context.pageIdentity === current.pageIdentity;
    return current.pageIdentity !== null && context.pageIdentity === current.pageIdentity;
}

function scopeForApiContext(context) {
    if (context.query !== null) return `query:${context.query}|page:${context.pageIdentity || ''}`;
    return `page:${context.pageIdentity || ''}`;
}

export function getWalmartScope() {
    const current = currentApiPageContext();
    if (current.query !== null) return `query:${current.query}|page:${current.pageIdentity || ''}`;
    return current.pageIdentity === null ? null : `page:${current.pageIdentity}`;
}

function apiProductForContainer(container) {
    const activeScope = getWalmartScope();
    if (activeScope === null || apiProductScope !== activeScope) return null;
    const productId = container.getAttribute('data-item-id');
    return productId ? mapGet(apiProductsById, productId) || null : null;
}

function ingestApiProductsMessageTransaction(event) {
    if (event.source !== window || event.origin !== window.location?.origin) {
        reportApiStatus('warn', 'rejected product message from an unexpected origin');
        return false;
    }
    const transactionGeneration = ++apiMessageGeneration;
    const message = event.data;
    if (!message || typeof message !== 'object') return false;
    const source = message.source;
    const version = message.version;
    const type = message.type;
    const mode = message.mode;
    const productsPayload = message.products;
    const contextPayload = message.context;
    const revisionPayload = message.revision;
    if (source !== API_BRIDGE_SOURCE || type !== 'api-products') return false;
    if (source !== API_BRIDGE_SOURCE || version !== API_BRIDGE_VERSION ||
        type !== 'api-products' || !['batch', 'snapshot'].includes(mode) ||
        !isProductArray(productsPayload)) {
        reportApiStatus('warn', 'rejected malformed product message');
        return false;
    }
    const productCount = productsPayload.length;
    if (!Number.isSafeInteger(productCount) || productCount < 0 || productCount > MAX_API_PRODUCTS) {
        reportApiStatus('warn', 'rejected oversized product message');
        return false;
    }
    const context = normalizeApiContext(contextPayload);
    if (!context || !apiContextMatchesCurrentPage(context)) {
        reportApiStatus('debug', 'ignored product message for a different search', {
            messageQuery: context?.query ?? null,
            currentQuery: currentApiPageContext().query,
            revision: revisionPayload
        });
        return false;
    }
    if (!Number.isSafeInteger(revisionPayload) || revisionPayload < 0
        || revisionPayload > MAX_API_REVISION) {
        reportApiStatus('warn', 'rejected malformed product revision');
        return false;
    }
    const revision = revisionPayload;
    if (revision < apiProductRevision || revision - apiProductRevision > MAX_API_REVISION_ADVANCE) {
        reportApiStatus('debug', 'ignored an out-of-sequence product revision', {
            revision,
            activeRevision: apiProductRevision
        });
        return false;
    }
    const nextScope = scopeForApiContext(context);
    const normalizedProducts = [];
    const normalizedProductIds = new NativeMap();
    for (let index = 0; index < productCount; index += 1) {
        const value = productsPayload[index];
        const product = normalizeApiProduct(value);
        if (!product) continue;
        if (mapGet(normalizedProductIds, product.id)) return false;
        mapSet(normalizedProductIds, product.id, true);
        normalizedProducts.push(product);
    }
    if (transactionGeneration !== apiMessageGeneration) return false;
    const nextProducts = new NativeMap();
    const replacesCache = mode === 'snapshot' || nextScope !== apiProductScope;
    if (!replacesCache) {
        const currentKeys = mapKeys(apiProductsById);
        for (let step = mapIteratorNext(currentKeys); !step.done; step = mapIteratorNext(currentKeys)) {
            mapSet(nextProducts, step.value, mapGet(apiProductsById, step.value));
        }
    }
    let changed = replacesCache && (mapSize(apiProductsById) > 0 || nextScope !== apiProductScope);
    for (const product of normalizedProducts) {
        const previous = mapGet(nextProducts, product.id);
        if (previous && previous.requestSequence !== null && product.requestSequence !== null &&
            previous.requestSequence > product.requestSequence) continue;
        if (JSON.stringify(previous) === JSON.stringify(product)) continue;
        mapDelete(nextProducts, product.id);
        mapSet(nextProducts, product.id, product);
        changed = true;
    }
    while (mapSize(nextProducts) > MAX_API_PRODUCTS) {
        mapDelete(nextProducts, mapIteratorNext(mapKeys(nextProducts)).value);
        changed = true;
    }
    // Commit only after every message-owned property has been read and
    // normalized successfully. A throwing accessor cannot partially replace
    // the last accepted current-scope cache.
    mapClear(apiProductsById);
    const nextKeys = mapKeys(nextProducts);
    for (let step = mapIteratorNext(nextKeys); !step.done; step = mapIteratorNext(nextKeys)) {
        mapSet(apiProductsById, step.value, mapGet(nextProducts, step.value));
    }
    apiProductScope = nextScope;
    apiProductRevision = Math.max(apiProductRevision, revision);
    reportApiStatus('info', 'accepted sanitized product message', {
        mode,
        revision,
        query: context.query,
        page: context.page,
        receivedProducts: productCount,
        cachedProducts: mapSize(apiProductsById),
        changed
    });
    scheduleProductScan({
        urgent: true,
        force: changed,
        apiReport: changed ? {
        mode,
        revision,
        query: context.query,
        receivedProducts: productCount
        } : null
    });
    // Queue annotation first. Lifecycle subscribers (including the sorter) then
    // join the same animation frame after the trusted card model is refreshed.
    lifecycle?.accept(nextScope);
    return changed;
}

function ingestApiProductsMessage(event) {
    try {
        return ingestApiProductsMessageTransaction(event);
    } catch (error) {
        reportApiStatus('warn', 'rejected non-transactional product message', {
            message: String(error?.message || error).slice(0, 240)
        });
        return false;
    }
}

function getUnit(unitText) {
    if (typeof unitText !== 'string') return null;
    const normalized = unitText.trim().toLowerCase().replace(/\s+/g, ' ');
    for (let i = 0; i < Unit.All.length; i++) {
        if (new RegExp(`^(?:${Unit.All[i].RegexString})$`, 'i').test(normalized)) return Unit.All[i];
    }
    return null;
}

function parseWalmartPricePerUnitText(pricePerUnitText) {
    if (typeof pricePerUnitText !== 'string') return null;
    // Examples: "11¢/100ml", "$1.23/100g", "$0.50/ea", or "$1.25/fl oz".
    const unitAliases = Unit.All.map(unit => unit.RegexString).join('|');
    const match = pricePerUnitText.trim().match(new RegExp(
        `(?:\\$\\s*(${numberRegexString})|(${numberRegexString})\\s*¢)\\s*\\/\\s*(?:(${numberRegexString})\\s*)?(${unitAliases})(?![a-zA-Z])`,
        'i'
    ));
    if (!match) return null;
    let value = parseFloat(match[1] || match[2]);
    if (match[2]) value = value / 100; // convert cents to dollars
    const amount = match[3] ? parseFloat(match[3]) : 1;
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000
        || !Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000) return null;
    const unit = match[4].toLowerCase();
    const parsedUnit = getUnit(unit);
    if (!parsedUnit) return null;
    return {
        value: value,
        amount: amount,
        unit: parsedUnit,
        text: `$${value.toFixed(2)}/${amount}${unit}`
    };
}

function extractApiPricePerUnit(product) {
    const value = product?.unitPrice;
    if (typeof value === 'string') return parseWalmartPricePerUnitText(value);
    return parseWalmartPricePerUnitText(value?.priceString || '');
}

function extractPromotion(container) {
    // Look for promotion like "2 for 8" in the badge
    const promoEl = container.querySelector('[data-testid="tag-leading-badge"]');
    if (!promoEl) return null;
    const promoText = promoEl.textContent.trim().toLowerCase();
    // Match "2 for 8", "3 for 10", etc.
    const match = promoText.match(/(\d+)\s*for\s*\$?(\d+(\.\d+)?)/i);
    if (!match) return null;
    return {
        qty: parseInt(match[1], 10),
        total: parseFloat(match[2])
    };
}

function extractCoupon(container) {
    // Look for coupon like "$2 coupon" in the banner
    const couponEl = container.querySelector('[data-testid="product-promo-banner"]');
    if (!couponEl) return null;
    const couponText = couponEl.textContent.trim().toLowerCase();
    // Match "$2 coupon", "$1.50 coupon", etc.
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
            return 'mass';
        case Unit.Milliliter:
        case Unit.Liter:
        case Unit.FluidOunce:
            return 'volume';
        case Unit.Count:
        case Unit.Load:
            return 'count';
        default:
            return 'unknown';
    }
}

function amountInBaseUnit(amount, unit) {
    if (!Number.isFinite(amount) || amount <= 0 || !unit) return null;
    if (unit === Unit.Count || unit === Unit.Load) return amount;
    if (!Number.isFinite(unit.ScaleToStandardUnit)) return null;
    return amount * unit.ScaleToStandardUnit;
}

function collectUnitCandidates(title) {
    const aliases = Unit.All.map(unit => unit.RegexString).join('|');
    const regex = new RegExp(`(${numberRegexString})\\s*(${aliases})(?![a-zA-Z])`, 'gi');
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
        new RegExp(`^\\s*\\/\\s*units?\\b[\\s,;|/-]*(${numberRegexString})\\s*units?\\s*\\/\\s*case\\b`, 'i'),
        new RegExp(`^[\\s,;|/()-]*(${numberRegexString})\\s*units?\\s*\\/\\s*case\\b`, 'i')
    ];
    for (const regex of packagePatterns) {
        const match = suffix.match(regex);
        const multiplier = match ? parseFloat(match[1]) : 1;
        if (Number.isFinite(multiplier) && multiplier > 1) return { multiplier };
    }

    // A net weight followed by "8-pack" commonly describes eight pieces in
    // one already-total package (buns, burgers, cookies). Only infer a small
    // multipack when the title also names an individual container, as in the
    // live cilantro result "Spice Shaker, 115 g, 2-Pack". It still cannot
    // override an explicit retailer PPU.
    const packMatch = suffix.match(new RegExp(`^[\\s,;|/()-]*(${numberRegexString})\\s*(?:-\\s*)?packs?\\b`, 'i'));
    const packCount = packMatch ? parseFloat(packMatch[1]) : 1;
    const packageContext = title.slice(0, candidate.index);
    if (Number.isFinite(packCount) && packCount > 1 && packCount <= 4 &&
        /\b(?:bottles?|jars?|shakers?|pouches?|bags?|boxes?|cans?|tubs?|cartons?|packets?)\b/i.test(packageContext)) {
        return { multiplier: packCount };
    }

    // A bare net weight followed by an item count is ambiguous: "800 g,
    // 8 count" usually means 800 g total, not 8 x 800 g. Accept count as a
    // multiplier only when the title separately corroborates the per-item
    // amount, as Walmart case titles do with notation such as "12c400g".
    const countMatch = suffix.match(new RegExp(`^[\\s,;|/()-]*(${numberRegexString})\\s*(?:-\\s*)?(?:ct|counts?)\\b`, 'i'));
    const count = countMatch ? parseFloat(countMatch[1]) : 1;
    if (Number.isFinite(count) && count > 1) {
        const amountText = String(candidate.amount).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const unitText = candidate.unitText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const corroboration = new RegExp(`\\b${count}\\s*c\\s*${amountText}\\s*${unitText}\\b`, 'i');
        if (corroboration.test(title)) return { multiplier: count };
    }
    return { multiplier: 1 };
}

function preferredPhysicalCandidates(candidates, preferredDimension) {
    let physical = candidates.filter(candidate => candidate.unit !== Unit.Count && candidate.unit !== Unit.Load);
    if (preferredDimension === 'mass' || preferredDimension === 'volume') {
        const matching = physical.filter(candidate => dimensionForUnit(candidate.unit) === preferredDimension);
        if (matching.length) physical = matching;
    }

    // Prefer a metric equivalent when a title provides both, such as
    // "8 oz (227 g)", to avoid small conversion and rounding discrepancies.
    const withoutOunces = physical.filter(candidate => candidate.unit !== Unit.Ounce);
    if (withoutOunces.length) physical = withoutOunces;

    const dimensions = new Set(physical.map(candidate => dimensionForUnit(candidate.unit)).filter(dimension => dimension !== 'unknown'));
    if (dimensions.size > 1) return [];

    // Prefer a metric equivalent over pounds when both describe the same
    // package, for example "5 lbs (2.27 kg)".
    const metric = physical.filter(candidate =>
        candidate.unit === Unit.Gram || candidate.unit === Unit.Kilogram ||
        candidate.unit === Unit.Milliliter || candidate.unit === Unit.Liter
    );
    return metric.length ? metric : physical;
}

function candidateLooksLikeClaim(title, candidate) {
    const before = title.slice(Math.max(0, candidate.index - 36), candidate.index);
    const after = title.slice(candidate.end, candidate.end + 44);
    const claim = '(?:protein|sodium|sugar|fat|fibre|fiber|carbohydrates?|calcium|iron|caffeine|dosage|strength|capacity)';
    return new RegExp(`\\b${claim}\\s*$`, 'i').test(before) ||
        new RegExp(`^\\s*(?:of\\s+(?:[a-z-]+\\s+){0,2})?${claim}\\b`, 'i').test(after) ||
        /\b(?:serving(?:\s+size)?|dose)\s*$/i.test(before) ||
        /^\s*(?:per\s+)?(?:serving|dose)\b/i.test(after);
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
    if (typeof sourceTitle !== 'string' || !sourceTitle.trim()) return null;
    const title = sourceTitle.toLowerCase();

    // Bulk match count (e.g., "6 x 200 mL")
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
                unit: unit,
                packageMultiplier: multiplier
            };
            if (unit === Unit.Load) return bulkUnitObj;
        }
    }

    const candidates = collectUnitCandidates(title);
    const loads = candidates.filter(candidate => candidate.unit === Unit.Load && candidate.amount > 0);
    if (loads.length) {
        return {
            amount: loads[loads.length - 1].amount,
            unit: Unit.Load
        };
    }
    if (bulkUnitObj) return bulkUnitObj;

    const physical = preferredPhysicalCandidates(candidates, preferredDimension)
        .filter(candidate => !candidateLooksLikeClaim(title, candidate));
    if (physical.length) {
        const dimension = dimensionForUnit(physical[0].unit);
        const comboCandidates = physical.filter(candidate => dimensionForUnit(candidate.unit) === dimension);

        // Explicit combo packs list multiple purchased quantities rather than
        // equivalent measurements. Sum only same-dimension metric quantities;
        // ordinary parenthetical imperial/metric equivalents are handled above.
        if (/\bcombo\s*(?:pack|kit|set)?\b/i.test(title) && comboCandidates.length > 1) {
            const distinctComboCandidates = comboCandidates.filter((candidate, index, all) =>
                index === 0 || !candidatesAreEquivalentMeasurement(title, all[index - 1], candidate)
            );
            const totalBaseAmount = distinctComboCandidates.reduce((total, candidate) =>
                total + (amountInBaseUnit(candidate.amount, candidate.unit) || 0), 0);
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

        const ranked = physical.map(candidate => {
            const packageDetails = packageDetailsAfter(title, candidate);
            return {
                ...candidate,
                packageMultiplier: packageDetails.multiplier
            };
        }).sort((a, b) =>
            b.packageMultiplier - a.packageMultiplier ||
            b.index - a.index
        );
        const selected = ranked[0];
        return {
            amount: selected.amount * selected.packageMultiplier,
            unit: selected.unit,
            packageMultiplier: selected.packageMultiplier
        };
    }

    // A singleton merchandising suffix ("1ct", "1 pack") adds no useful
    // unit-price information and must not override a real package quantity.
    const counts = candidates.filter(candidate => candidate.unit === Unit.Count && candidate.amount > 1);
    if (!counts.length) return null;
    const count = counts[counts.length - 1];
    return {
        amount: count.amount,
        unit: Unit.Count
    };
}

function isUnambiguousVariantUnit(sourceTitle, unitObj) {
    if (typeof sourceTitle !== 'string' || !unitObj) return false;
    if (unitObj.isComposite) return true;
    const dimension = dimensionForUnit(unitObj.unit);
    if (dimension === 'unknown') return false;
    const title = sourceTitle.toLowerCase();
    const candidates = collectUnitCandidates(title).filter(candidate =>
        dimensionForUnit(candidate.unit) === dimension && !candidateLooksLikeClaim(title, candidate)
    );
    if (candidates.length === 0) return false;
    if (candidates.length === 1) return true;
    const amounts = candidates.map(candidate => amountInBaseUnit(candidate.amount, candidate.unit));
    if (amounts.some(amount => !(amount > 0))) return false;
    const reference = amounts[0];
    return amounts.every(amount => Math.abs(amount - reference) / Math.max(amount, reference) <= 0.04);
}

function resolveVariableOptionUnit(apiProduct, sourceTitle, unitObj) {
    if (isUnambiguousVariantUnit(sourceTitle, unitObj)) return unitObj;
    if (apiProduct?.currentVariantConfirmed !== true || !apiProduct.currentVariantName) return null;
    const currentVariantUnit = extractUnitFromTitle(apiProduct.currentVariantName);
    return isUnambiguousVariantUnit(apiProduct.currentVariantName, currentVariantUnit)
        ? currentVariantUnit
        : null;
}

function pricePerStandardUnit(price, unitObj) {
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000 || !unitObj ||
        !Number.isFinite(unitObj.amount) || unitObj.amount <= 0 ||
        !Number.isFinite(unitObj.unit?.ScaleToStandard)) return null;
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
    container.querySelector('.price-per-unit-info')?.remove();
    delete container.dataset.ppuSortValue;
    delete container.dataset.ppuSortDimension;
    delete container.dataset.ppuSortUnit;
}

function showPricePerUnit(container, price, unitObj, _promo, _couponValue, walmartPricePerUnit) {
    const hasPackageBasis = Number.isFinite(price) && price > 0 && price <= 1_000_000 && unitObj;
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

    // Use the same display denominator on every supported retailer.
    const preferredUnit = getPreferredUnit(unitObj);
    unitObj = convertUnitObject(unitObj, preferredUnit);

    // Display on page
    let infoDiv = container.querySelector('.price-per-unit-info');
    if (!infoDiv) {
        infoDiv = document.createElement('div');
    } else {
        // Clear previous content if reusing
        while (infoDiv.firstChild) {
            infoDiv.removeChild(infoDiv.firstChild);
        }
    }

    infoDiv.className = 'price-per-unit-info lups-annotation';
    infoDiv.setAttribute('data-lups-annotation', '');

    const pricePerUnit = pricePerStandardUnit(price, unitObj);
    if (!Number.isFinite(pricePerUnit)) {
        clearSortModel(container);
        return;
    }
    // Expose a dimension-safe normalized value for the optional sorter.
    // Keeping this small interface on the card lets sort.js remain independent
    // from the price extraction implementation and easy to merge with upstream.
    const sortable = normalizePriceForSorting(pricePerUnit, unitObj.unit);
    if (sortable) {
        container.dataset.ppuSortValue = String(sortable.value);
        container.dataset.ppuSortDimension = sortable.dimension;
        container.dataset.ppuSortUnit = sortable.unit;
        infoDiv.dataset.source = usedWalmartPPU ? 'retailer' : 'calculated';
        const origin = usedWalmartPPU ? 'Retailer' : 'Calculated';
        infoDiv.textContent = `${formatUnitPrice(sortable.value, sortable.unit)} · ${origin}`;
        infoDiv.title = usedWalmartPPU ? 'Unit price supplied by the retailer API' : 'Calculated from retailer API package and price data';
        const description = `${infoDiv.title[0].toLowerCase()}${infoDiv.title.slice(1)}`;
        infoDiv.setAttribute('aria-label', `${speakUnitPrice(sortable.value, sortable.unit)}, ${description}`);
    } else {
        clearSortModel(container);
        return;
    }

    // Insert after price
    const priceEl = container.querySelector('[data-automation-id="product-price"]');
    if (priceEl && priceEl.parentNode) {
        priceEl.parentNode.insertBefore(infoDiv, priceEl.nextSibling);
    } else {
        container.prepend(infoDiv);
    }

    return pricePerUnit;
}

function normalizePriceForSorting(pricePerUnit, unit) {
    if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0 || pricePerUnit > 1_000_000_000 || !unit) return null;
    switch (unit) {
        case Unit.Gram:
        case Unit.Kilogram:
            return { value: pricePerUnit * 10, dimension: 'mass', unit: 'CAD/kg' };
        case Unit.Pound:
            return { value: pricePerUnit / 0.453592, dimension: 'mass', unit: 'CAD/kg' };
        case Unit.Ounce:
            return { value: pricePerUnit / 0.0283495, dimension: 'mass', unit: 'CAD/kg' };
        case Unit.Milliliter:
        case Unit.Liter:
            return { value: pricePerUnit * 10, dimension: 'volume', unit: 'CAD/L' };
        case Unit.FluidOunce:
            return { value: pricePerUnit / 0.0295735, dimension: 'volume', unit: 'CAD/L' };
        case Unit.Count:
        case Unit.Load:
            return { value: pricePerUnit, dimension: 'count', unit: 'CAD/item' };
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
    const text = selector => container.querySelector(selector)?.textContent?.trim() || '';
    return JSON.stringify([
        container.getAttribute('data-item-id') || '',
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

function ownedStateSignature(container) {
    const annotation = container.querySelector('.price-per-unit-info');
    return JSON.stringify([
        Boolean(annotation),
        annotation?.textContent || '',
        container.dataset.ppuTotalPrice || '',
        container.dataset.ppuSortValue || '',
        container.dataset.ppuSortDimension || '',
        container.dataset.ppuSortUnit || ''
    ]);
}

function ownedNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.matches?.('#lups-control, #ppu-sort-control, .price-per-unit-info, .ppu-walmart-icon, [data-lups-annotation]') ||
        element?.closest?.('#lups-control, #ppu-sort-control, .price-per-unit-info, .ppu-walmart-icon, [data-lups-annotation]'));
}

function ownedMutation(mutation) {
    if (mutation.type === 'attributes' && mutation.attributeName?.startsWith('data-ppu-')) return true;
    if (ownedNode(mutation.target)) return true;
    const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return changedNodes.length > 0 && changedNodes.every(ownedNode);
}

// Select all product containers (adjust selector as needed)
function processProducts(isForced = false, apiReport = null) {
        const productContainers = document.querySelectorAll('[data-item-id]');
        let exposedStateChanged = false;
        if (productContainers.length > MAX_RENDERED_CARDS) {
            const managedIterator = setValues(managedProductContainers);
            for (let step = setIteratorNext(managedIterator); !step.done; step = setIteratorNext(managedIterator)) {
                const container = step.value;
                const previousState = ownedStateSignature(container);
                clearSortModel(container);
                delete container.dataset.ppuTotalPrice;
                delete container.dataset.ppuDataSource;
                delete container.dataset.ppuProcessingError;
                weakMapDelete(processedSignatures, container);
                weakMapDelete(processedStates, container);
                setDelete(managedProductContainers, container);
                exposedStateChanged ||= previousState !== ownedStateSignature(container);
            }
            const publication = publishApiScanState({ accepted: false, renderedCards: 0, apiCards: 0 }, []);
            if (exposedStateChanged || publication.changed) window.dispatchEvent(new CustomEvent('ppu-products-updated'));
            reportApiStatus('warn', 'skipped an oversized rendered product set', {
                renderedCardNodes: productContainers.length,
                maximum: MAX_RENDERED_CARDS
            });
            return;
        }
        // Virtualized Walmart cards can temporarily lose their identity
        // attribute. Reconcile containers we previously annotated before the
        // current selector drops them, so stale prices never survive recycling.
        const managedIterator = setValues(managedProductContainers);
        for (let step = setIteratorNext(managedIterator); !step.done; step = setIteratorNext(managedIterator)) {
            const container = step.value;
            if (!container.isConnected) {
                weakMapDelete(processedSignatures, container);
                weakMapDelete(processedStates, container);
                setDelete(managedProductContainers, container);
                continue;
            }
            if (container.getAttribute('data-item-id')) continue;
            const previousState = ownedStateSignature(container);
            clearSortModel(container);
            delete container.dataset.ppuTotalPrice;
            delete container.dataset.ppuDataSource;
            delete container.dataset.ppuProcessingError;
            weakMapDelete(processedSignatures, container);
            weakMapDelete(processedStates, container);
            setDelete(managedProductContainers, container);
            exposedStateChanged ||= previousState !== ownedStateSignature(container);
        }
        const trustedModels = [];
        const scan = {
            renderedCards: 0,
            apiCards: 0,
            missingApiCards: 0,
            sortableCards: 0,
            errors: 0
        };
        productContainers.forEach(container => {
            const previousState = ownedStateSignature(container);
            try {
            // Get product ID
            const productId = container.getAttribute('data-item-id');
            if (!productId) return;
            setAdd(managedProductContainers, container);
            if (getComputedStyle(container).display === 'none') {
                clearSortModel(container);
                delete container.dataset.ppuTotalPrice;
                delete container.dataset.ppuProcessingError;
                weakMapDelete(processedSignatures, container);
                weakMapDelete(processedStates, container);
                delete container.dataset.ppuDataSource;
                exposedStateChanged ||= previousState !== ownedStateSignature(container);
                return;
            }
            scan.renderedCards += 1;
            const apiProduct = apiProductForContainer(container);
            const signature = productSourceSignature(container, apiProduct);
            if (apiProduct) scan.apiCards += 1;
            else scan.missingApiCards += 1;
            if (!isForced && weakMapGet(processedSignatures, container) === signature &&
                weakMapGet(processedStates, container) === ownedStateSignature(container)) {
                if (container.dataset.ppuSortDimension && container.dataset.ppuSortValue) scan.sortableCards += 1;
                trustedModels.push({
                    card: container,
                    matched: Boolean(apiProduct),
                    normalizedUnitPrice: Number(container.dataset.ppuSortValue),
                    currentPrice: Number(container.dataset.ppuTotalPrice),
                    dimension: container.dataset.ppuSortDimension
                });
                return;
            }

            if (!apiProduct) {
                clearSortModel(container);
                delete container.dataset.ppuTotalPrice;
                delete container.dataset.ppuDataSource;
                delete container.dataset.ppuProcessingError;
                weakMapSet(processedSignatures, container, signature);
                const nextState = ownedStateSignature(container);
                weakMapSet(processedStates, container, nextState);
                exposedStateChanged ||= previousState !== nextState;
                trustedModels.push({ card: container, matched: false });
                return;
            }

            const price = apiProduct.price;
            const sortableTotalPrice = Number.isFinite(price) ? price : apiProduct.averagePrice;
            if (Number.isFinite(sortableTotalPrice) && sortableTotalPrice > 0 && sortableTotalPrice <= 1_000_000) {
                container.dataset.ppuTotalPrice = String(sortableTotalPrice);
            }
            else delete container.dataset.ppuTotalPrice;
            const promo = extractPromotion(container);
            const couponValue = extractCoupon(container);
            const walmartPricePerUnit = extractApiPricePerUnit(apiProduct);
            const productTitle = apiProduct.name;
            let unitObj = extractUnitFromTitle(productTitle, dimensionForUnit(walmartPricePerUnit?.unit));
            if (apiProduct.variableOptions === true) {
                unitObj = resolveVariableOptionUnit(apiProduct, productTitle, unitObj);
            }
            container.dataset.ppuDataSource = 'api';
            showPricePerUnit(container, price, unitObj, promo, couponValue, walmartPricePerUnit);
            weakMapSet(processedSignatures, container, signature);
            const nextState = ownedStateSignature(container);
            weakMapSet(processedStates, container, nextState);
            exposedStateChanged ||= previousState !== nextState;
            if (container.dataset.ppuSortDimension && container.dataset.ppuSortValue) scan.sortableCards += 1;
            trustedModels.push({
                card: container,
                matched: true,
                normalizedUnitPrice: Number(container.dataset.ppuSortValue),
                currentPrice: Number(container.dataset.ppuTotalPrice),
                dimension: container.dataset.ppuSortDimension
            });
            delete container.dataset.ppuProcessingError;
            } catch (error) {
                // One malformed or newly half-rendered card must not prevent
                // later products from being processed. Keep diagnostics local.
                container.dataset.ppuProcessingError = String(error?.message || error).slice(0, 160);
                weakMapDelete(processedSignatures, container);
                weakMapDelete(processedStates, container);
                exposedStateChanged ||= previousState !== ownedStateSignature(container);
                trustedModels.push({ card: container, matched: false });
                scan.errors += 1;
                reportApiStatus('error', 'failed to process a product card', {
                    productId: container.getAttribute('data-item-id') || null,
                    message: String(error?.message || error).slice(0, 240)
                });
            }
        });
        const publication = publishApiScanState({
            accepted: apiProductScope !== null && apiProductScope === getWalmartScope(),
            renderedCards: scan.renderedCards,
            apiCards: scan.apiCards
        }, trustedModels);
        if (exposedStateChanged || publication.changed) window.dispatchEvent(new CustomEvent('ppu-products-updated'));
        if (apiReport) {
            reportApiStatus('info', 'applied product data to rendered cards', {
                ...apiReport,
                cachedApiProducts: mapSize(apiProductsById),
                totalCardNodes: productContainers.length,
                ...scan
            });
        }
}

// Re-run when DOM changes. Accepted API snapshots promote any pending 150 ms
// DOM scan to the next animation frame through the shared retailer scheduler.
let productScanScheduler = null;
let pendingForcedScan = false;
let pendingApiReport = null;
function runProductScan() {
    const forced = pendingForcedScan;
    const apiReport = pendingApiReport;
    pendingForcedScan = false;
    pendingApiReport = null;
    processProducts(forced, apiReport);
}
function scheduleProductScan({ urgent = false, force = false, apiReport = null } = {}) {
    pendingForcedScan ||= force;
    if (apiReport) pendingApiReport = apiReport;
    return productScanScheduler?.({ urgent }) || false;
}
let productObserver;
let productProcessingStarted = false;
let observedApiScope = getWalmartScope();

function detectPageScopeChange() {
    const nextScope = getWalmartScope();
    if (nextScope === observedApiScope) return;
    observedApiScope = nextScope;
    lifecycle?.beginWaiting(nextScope);
    scheduleProductScan();
}

function startProductProcessing() {
    if (productProcessingStarted || !document.body) return;
    productProcessingStarted = true;
    processProducts();
    productObserver = new MutationObserver(mutations => {
        const ownedOnly = areOnlyOwnedMutations(mutations, ownedMutation);
        if (!ownedOnly) scheduleProductScan();
    });
    productObserver.observe(document.body, {
        attributes: true,
        attributeFilter: [
            'class', 'hidden', 'data-item-id', 'data-ppu-total-price',
            'data-ppu-sort-value', 'data-ppu-sort-dimension', 'data-ppu-sort-unit'
        ],
        childList: true,
        characterData: true,
        subtree: true
    });
    window.addEventListener('scroll', scheduleProductScan, { passive: true });
    // pushState/replaceState do not emit a browser navigation event. A small
    // page-lifetime scope watcher makes URL-only Walmart transitions promptly
    // invalidate stale annotations without modifying the retailer's History
    // methods or relying on unrelated DOM churn.
    window.addEventListener('popstate', detectPageScopeChange, { passive: true });
    setInterval(detectPageScopeChange, 200);
}

export function installWalmartAnnotator(context = {}) {
    if (!claimRuntimeInstall('walmart-content')) return false;
    lifecycle = context.lifecycle || null;
    productScanScheduler = createScanScheduler(window, runProductScan, { delayMs: 150 });
    window.addEventListener('message', ingestApiProductsMessage);
    reportApiStatus('info', 'page-world bridge ready; requesting captured product snapshot');
    window.postMessage?.({
        source: API_BRIDGE_SOURCE,
        version: API_BRIDGE_VERSION,
        type: 'api-products-request'
    }, window.location?.origin || '*');
    if (document.body) startProductProcessing();
    else document.addEventListener('DOMContentLoaded', startProductProcessing, { once: true });
    return true;
}
