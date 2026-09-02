/*!
 * Walmart page-world API capability. Installed at document-start, it watches
 * Walmart's bounded GraphQL search/cart traffic, keeps request details inside
 * this lexical closure, and exposes only narrow query/add/review operations to
 * the retailer plugin. Sanitized search records are still scoped to the current
 * route and published only after response/sequence checks pass.
 */
export function installWalmartCapture(global = window) {
    const SOURCE = 'walmart-price-per-unit';
    const VERSION = 2;
    const PRODUCTS_TYPE = 'api-products';
    const REQUEST_TYPE = 'api-products-request';
    const CACHE_LIMIT = 500;
    const MAX_WALK_NODES = 20000;
    const MAX_EXTRACTED_ITEMS = 2000;
    const MAX_CONTAINER_ENTRIES = 500;
    const MAX_PRELOADED_TEXT_LENGTH = 10000000;
    const SEARCH_PATH = /^\/orchestra\/snb\/graphql\/search(?:\/[^/]+\/search)?\/?$/i;
    const CART_QUERY_PATH = /^\/orchestra\/graphql\/mergeandgetcart\/[a-f0-9]{64}\/?$/i;
    const CART_UPDATE_PATH = /^\/orchestra\/graphql\/updateitems\/[a-f0-9]{64}\/?$/i;
    // Persisted-operation hashes can change when Walmart deploys. Every live
    // request replaces these seeds; the seeds only let a freshly loaded search
    // page work before the user has performed the same operation manually.
    const SEARCH_SEED_PATH = '/orchestra/snb/graphql/Search/5088ca7b454e3b004b3bf929c79c521d658f4bf5a9e04d1c9b6037bb7c1296c1/search';
    const CART_UPDATE_SEED_PATH = '/orchestra/graphql/updateItems/45fca98d0f0fb2ffc2ccf8a3290b89141cdad6c9096c3fe39303e2fdf8f524b1';
    const MAX_CART_LINES = 500;
    const INSTALL_KEY = typeof Symbol === 'function'
        ? Symbol.for('walmart-price-per-unit.api-capture.v1')
        : '__walmartPricePerUnitApiCaptureV1__';
    const LOG_PREFIX = '[WPPU API]';

    function report(target, level, message, details) {
        try {
            const logger = target && target.console && target.console[level];
            if (typeof logger !== 'function') return;
            if (details === undefined) logger.call(target.console, LOG_PREFIX, message);
            else logger.call(target.console, LOG_PREFIX, message, details);
        } catch (_error) {
            // Console reporting must never affect the storefront.
        }
    }

    function errorDetails(error) {
        return {
            name: cleanText(error && error.name, 80) || 'Error',
            message: cleanText(error && error.message, 240) || String(error || 'Unknown error').slice(0, 240)
        };
    }

    function cleanText(value, maximumLength) {
        if (typeof value !== 'string') return null;
        const text = value.trim();
        if (!text) return null;
        return text.slice(0, maximumLength);
    }

    function cleanScalar(value, maximumTextLength = 128) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string') return cleanText(value, maximumTextLength);
        return null;
    }

    function cleanNumber(value) {
        if (typeof value === 'number') return Number.isFinite(value) && value > 0 && value <= 1_000_000 ? value : null;
        if (typeof value !== 'string') return null;
        const normalized = value.trim().replace(/,/g, '');
        if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
        const number = Number(normalized);
        return Number.isFinite(number) && number > 0 && number <= 1_000_000 ? number : null;
    }

    function cleanDisplayedPrice(value) {
        const number = cleanNumber(value);
        if (number !== null) return number;
        const text = cleanText(value, 64);
        if (text === null) return null;
        const cents = text.match(/^(\d+(?:\.\d+)?)\s*¢$/);
        if (cents) {
            const price = Number(cents[1]) / 100;
            return price > 0 && price <= 1_000_000 ? price : null;
        }
        const dollars = text.match(/^\$\s*(\d+(?:,\d{3})*)(?:\.(\d{2}))?$/);
        if (!dollars) return null;
        const price = Number(`${dollars[1].replace(/,/g, '')}.${dollars[2] || '00'}`);
        return price > 0 && price <= 1_000_000 ? price : null;
    }

    function cleanUnitPrice(value) {
        if (typeof value === 'string') return cleanText(value, 128);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

        const price = cleanNumber(value.price);
        const priceString = cleanText(value.priceString, 128);
        if (price === null && priceString === null) return null;

        return { price, priceString };
    }

    function selectedVariantInfo(item) {
        const currentUsItemId = cleanScalar(item && item.usItemId, 256);
        const variants = Array.isArray(item && item.variantList) ? item.variantList.slice(0, 250) : [];
        if (currentUsItemId === null || variants.length === 0) {
            return { currentVariantConfirmed: false, currentVariantName: null };
        }
        const matches = variants.filter(variant =>
            cleanScalar(variant && variant.usItemId, 256) === currentUsItemId
        );
        if (matches.length !== 1) {
            return { currentVariantConfirmed: false, currentVariantName: null };
        }
        return {
            currentVariantConfirmed: true,
            currentVariantName: cleanText(matches[0].name, 256)
        };
    }

    function normalizeQuery(value) {
        const query = cleanText(value, 256);
        return query === null
            ? null
            : query.normalize('NFKC').replace(/\s+/g, ' ').toLowerCase();
    }

    function normalizePage(value) {
        if (typeof value === 'string' && /^\d+$/.test(value.trim())) value = Number(value.trim());
        return Number.isSafeInteger(value) && value >= 0 && value <= 10000 ? value : null;
    }

    function safePagePath(value, expectedOrigin) {
        if (typeof value !== 'string' || !value || typeof expectedOrigin !== 'string' || !expectedOrigin) return null;
        try {
            const url = new URL(value, expectedOrigin);
            if (url.origin !== expectedOrigin || !isWalmartHostname(url.hostname)) return null;
            return `${url.pathname}${url.search}`.slice(0, 2048);
        } catch (_error) {
            return null;
        }
    }

    function queryAndPageFromUrl(value, expectedOrigin) {
        const pagePath = safePagePath(value, expectedOrigin);
        if (pagePath === null) return { query: null, page: null, pagePath: null };
        const url = new URL(pagePath, expectedOrigin);
        return {
            query: normalizeQuery(url.searchParams.get('q')),
            page: normalizePage(url.searchParams.get('page')),
            pagePath
        };
    }

    function normalizedStoreIdentity(value) {
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
        return cleanText(value, 80)?.toLowerCase() || null;
    }

    function storeIdentityFromPage(value, expectedOrigin) {
        const pagePath = safePagePath(value, expectedOrigin);
        if (pagePath === null) return null;
        const url = new URL(pagePath, expectedOrigin);
        for (const key of ['store', 'storeId', 'store_id']) {
            const identity = normalizedStoreIdentity(url.searchParams.get(key));
            if (identity) return identity;
        }
        return null;
    }

    function storeIdentityFromVariables(variables) {
        if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return { value: null, ambiguous: false };
        const candidates = [
            variables.store,
            variables.storeId,
            variables.input?.storeId,
            variables.searchArgs?.storeId,
            variables.storeContext?.storeId
        ];
        if (Array.isArray(variables.storeIds) && variables.storeIds.length === 1) candidates.push(variables.storeIds[0]);
        const values = [...new Set(candidates.map(normalizedStoreIdentity).filter(Boolean))];
        return { value: values.length === 1 ? values[0] : null, ambiguous: values.length > 1 };
    }

    function canonicalRequestValue(value, depth = 0, budget = { entries: 0 }) {
        if (budget.entries >= 300 || depth > 7) return null;
        if (value === null || typeof value === 'boolean') return value;
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value === 'string') return value.slice(0, 256);
        if (Array.isArray(value)) {
            budget.entries += 1;
            return value.slice(0, 100).map(item => canonicalRequestValue(item, depth + 1, budget));
        }
        if (!value || typeof value !== 'object') return null;
        const result = {};
        for (const key of Object.keys(value).sort().slice(0, 100)) {
            budget.entries += 1;
            if (budget.entries > 300) break;
            result[key.slice(0, 128)] = canonicalRequestValue(value[key], depth + 1, budget);
        }
        return result;
    }

    function variablesFingerprint(variables) {
        if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return '';
        const filtered = { ...variables };
        delete filtered.query;
        delete filtered.page;
        if (Object.keys(filtered).length === 0) return '';
        return JSON.stringify(canonicalRequestValue(filtered)).slice(0, 8192);
    }

    function requestContext(requestUrl, pageUrlAtRequest, expectedOrigin) {
        let variables = null;
        try {
            const encodedVariables = requestUrl.searchParams.get('variables');
            if (encodedVariables) variables = JSON.parse(encodedVariables);
        } catch (_error) {
            variables = null;
        }

        const pageLocation = queryAndPageFromUrl(pageUrlAtRequest, expectedOrigin);
        const variableStore = storeIdentityFromVariables(variables);
        const pageStore = storeIdentityFromPage(pageUrlAtRequest, expectedOrigin);
        if (variableStore.ambiguous || (variableStore.value && pageStore && variableStore.value !== pageStore)) return null;
        return {
            query: normalizeQuery(variables && variables.query) ?? pageLocation.query,
            page: normalizePage(variables && variables.page) ?? pageLocation.page,
            storeId: variableStore.value || pageStore,
            variablesFingerprint: variablesFingerprint(variables),
            pageUrlAtRequest: pageLocation.pagePath,
            pageUrlAtCapture: null
        };
    }

    function initialNextDataContext(target, payload) {
        const expectedOrigin = target.location && target.location.origin;
        const pageLocation = queryAndPageFromUrl(target.location && target.location.href, expectedOrigin);
        const variables = payload && payload.props && payload.props.pageProps &&
            payload.props.pageProps.initialSearchQueryVariables;
        const variableQuery = normalizeQuery(variables && variables.query);
        const pageStore = storeIdentityFromPage(target.location && target.location.href, expectedOrigin);
        const variableStore = storeIdentityFromVariables(variables);
        if (variableStore.ambiguous || (pageLocation.query && variableQuery && pageLocation.query !== variableQuery)
            || (pageStore && variableStore.value && pageStore !== variableStore.value)) return null;
        return {
            query: variableQuery ?? pageLocation.query,
            page: pageLocation.page ?? normalizePage(variables && variables.page),
            storeId: variableStore.value || pageStore,
            variablesFingerprint: variablesFingerprint(variables),
            pageUrlAtRequest: pageLocation.pagePath,
            pageUrlAtCapture: pageLocation.pagePath
        };
    }

    function sanitizeContext(context, expectedOrigin) {
        if (!context || typeof context !== 'object') return null;
        const sanitized = {
            query: normalizeQuery(context.query),
            page: normalizePage(context.page),
            storeId: normalizedStoreIdentity(context.storeId),
            variablesFingerprint: cleanText(context.variablesFingerprint, 8192) || '',
            pageUrlAtRequest: safePagePath(context.pageUrlAtRequest, expectedOrigin),
            pageUrlAtCapture: safePagePath(context.pageUrlAtCapture, expectedOrigin)
        };
        sanitized.pageIdentity = pageIdentity(sanitized.pageUrlAtRequest || sanitized.pageUrlAtCapture, expectedOrigin);
        return sanitized;
    }

    function pageIdentity(value, expectedOrigin) {
        const pagePath = safePagePath(value, expectedOrigin);
        if (pagePath === null) return null;
        const url = new URL(pagePath, expectedOrigin);
        const parameters = [...url.searchParams.entries()]
            .filter(([key]) => !/^(?:q|page)$/i.test(key))
            .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
                leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
        const suffix = parameters.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
        return `${url.pathname.replace(/\/$/, '')}${suffix ? `?${suffix}` : ''}`;
    }

    function contextScope(context) {
        if (context && context.query !== null) return `query:${context.query}|page:${context.pageIdentity || ''}|store:${context.storeId || ''}|filter:${context.variablesFingerprint || ''}`;
        if (context && context.pageIdentity !== null) return `page:${context.pageIdentity}|store:${context.storeId || ''}|filter:${context.variablesFingerprint || ''}`;
        return 'unknown';
    }

    function isLaterPage(context) {
        return Number.isSafeInteger(context?.page) && context.page > 1;
    }

    function sanitizeProduct(item) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
        const id = cleanScalar(item.id, 256);
        if (id === null) return null;
        const key = String(id);
        if (!key) return null;
        const name = cleanText(item.name, 1000);
        if (name === null) return null;

        const currentPrice = item.priceInfo && item.priceInfo.currentPrice;
        let rawPrice = currentPrice && typeof currentPrice === 'object'
            ? currentPrice.price
            : currentPrice;
        if (rawPrice === null || rawPrice === undefined) rawPrice = item.price;
        const priceRangeString = cleanText(item.priceInfo && item.priceInfo.priceRangeString, 128);
        const priceDisplayCondition = cleanText(item.priceInfo && item.priceInfo.priceDisplayCondition, 64);
        const averagePrice = item.priceInfo && item.priceInfo.finalCostByWeight === true &&
            priceDisplayCondition && priceDisplayCondition.toLowerCase() === 'avg price'
            ? cleanDisplayedPrice(item.priceInfo.linePrice)
            : null;
        const variableOptions = item.showOptions === true ||
            (Number.isInteger(item.variantCount) && item.variantCount > 1) ||
            priceRangeString !== null;
        const variantInfo = selectedVariantInfo(item);
        const offerId = cleanScalar(item.offerId, 160);
        const usItemId = cleanScalar(item.usItemId, 160);
        const availability = cleanText(item.availabilityStatusV2 && item.availabilityStatusV2.value, 64);
        const cartKey = offerId !== null && usItemId !== null
            ? `w:${encodeURIComponent(String(usItemId))}:${encodeURIComponent(String(offerId))}`
            : null;

        return {
            id: key,
            name,
            price: cleanNumber(rawPrice),
            averagePrice,
            unitPrice: cleanUnitPrice(item.priceInfo && item.priceInfo.unitPrice),
            variableOptions,
            currentVariantConfirmed: variantInfo.currentVariantConfirmed,
            currentVariantName: variantInfo.currentVariantName,
            cartKey,
            offerId: offerId === null ? null : String(offerId),
            usItemId: usItemId === null ? null : String(usItemId),
            addable: cartKey !== null && item.buyBoxSuppression !== true
                && (availability === null || availability.toUpperCase() === 'IN_STOCK')
        };
    }

    function collectItemStackProducts(root, itemKeys) {
        if (!root || typeof root !== 'object') return [];
        const allowedItemKeys = new Set(itemKeys);
        const products = [];
        const pending = [root];
        const seen = new WeakSet();
        let inspected = 0;
        let pendingIndex = 0;
        let enqueued = 1;

        function enqueue(value) {
            if (!value || typeof value !== 'object' || enqueued >= MAX_WALK_NODES) return;
            pending.push(value);
            enqueued += 1;
        }

        while (pendingIndex < pending.length && inspected < MAX_WALK_NODES && products.length < MAX_EXTRACTED_ITEMS) {
            const value = pending[pendingIndex];
            pendingIndex += 1;
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            seen.add(value);
            inspected += 1;

            if (Array.isArray(value)) {
                const limit = Math.min(value.length, MAX_CONTAINER_ENTRIES);
                for (let index = 0; index < limit && enqueued < MAX_WALK_NODES; index += 1) {
                    enqueue(value[index]);
                }
                continue;
            }

            if (Array.isArray(value.itemStacks)) {
                const stackLimit = Math.min(value.itemStacks.length, MAX_CONTAINER_ENTRIES);
                for (let stackIndex = 0; stackIndex < stackLimit; stackIndex += 1) {
                    const itemStack = value.itemStacks[stackIndex];
                    if (!itemStack || typeof itemStack !== 'object') continue;
                    let stackItems = null;
                    for (const itemKey of allowedItemKeys) {
                        if (!Array.isArray(itemStack[itemKey])) continue;
                        stackItems = itemStack[itemKey];
                        break;
                    }
                    if (stackItems) {
                        const itemLimit = Math.min(stackItems.length, MAX_CONTAINER_ENTRIES);
                        for (let itemIndex = 0; itemIndex < itemLimit; itemIndex += 1) {
                            products.push(stackItems[itemIndex]);
                            if (products.length >= MAX_EXTRACTED_ITEMS) break;
                        }
                    }
                    if (products.length >= MAX_EXTRACTED_ITEMS) break;
                }
            }

            let visited = 0;
            for (const key in value) {
                if (visited >= MAX_CONTAINER_ENTRIES || enqueued >= MAX_WALK_NODES) break;
                if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
                visited += 1;
                if (key !== 'itemStacks') enqueue(value[key]);
            }
        }

        return products;
    }

    function isWalmartHostname(hostname) {
        const normalized = String(hostname || '').toLowerCase();
        return normalized === 'walmart.ca' || normalized.endsWith('.walmart.ca');
    }

    function allowedSearchUrl(input, baseHref, expectedOrigin) {
        try {
            let rawUrl = input;
            if (input && typeof input === 'object' && typeof input.url === 'string') rawUrl = input.url;
            if (typeof rawUrl !== 'string' && !(typeof URL === 'function' && rawUrl instanceof URL)) return null;
            const url = new URL(String(rawUrl), baseHref);
            if (url.origin !== expectedOrigin || !isWalmartHostname(url.hostname)) return null;
            return SEARCH_PATH.test(url.pathname) ? url : null;
        } catch (_error) {
            return null;
        }
    }

    function allowedApiUrl(input, baseHref, expectedOrigin, pathPattern) {
        try {
            let rawUrl = input;
            if (input && typeof input === 'object' && typeof input.url === 'string') rawUrl = input.url;
            if (typeof rawUrl !== 'string' && !(typeof URL === 'function' && rawUrl instanceof URL)) return null;
            const url = new URL(String(rawUrl), baseHref);
            if (url.origin !== expectedOrigin || !isWalmartHostname(url.hostname)) return null;
            return pathPattern.test(url.pathname) ? url : null;
        } catch (_error) {
            return null;
        }
    }

    function productsArray(entries) {
        const products = [];
        for (const [, product] of entries) products[products.length] = product;
        return products;
    }

    function createProductChannel(target, cacheLimit = CACHE_LIMIT) {
        const limit = Math.max(1, Math.floor(cacheLimit));
        const cache = new Map();
        let revision = 0;
        let activeScope = null;
        let activeContext = null;
        let activeContextSequence = -1;
        let latestBaseScope = null;
        let latestBaseSequence = 0;

        function publicContext(context) {
            if (!context) return null;
            return {
                query: context.query,
                page: context.page,
                storeId: context.storeId,
                pageUrlAtRequest: context.pageUrlAtRequest,
                pageUrlAtCapture: context.pageUrlAtCapture
            };
        }

        function post(mode, entries, context) {
            const message = {
                source: SOURCE,
                version: VERSION,
                type: PRODUCTS_TYPE,
                mode,
                revision,
                context: publicContext(context),
                products: productsArray(entries)
            };
            try {
                target.postMessage(message, target.location.origin);
                report(target, 'debug', `sent ${mode} product message`, {
                    revision,
                    query: context && context.query,
                    page: context && context.page,
                    products: entries.size,
                    cachedProducts: cache.size
                });
            } catch (_error) {
                // Capturing must never interfere with Walmart's page.
            }
        }

        function noteRequest(context, requestSequence) {
            const sequence = Number.isSafeInteger(requestSequence) && requestSequence >= 0
                ? requestSequence
                : 0;
            const normalizedContext = sanitizeContext(context, target.location.origin);
            if (!normalizedContext || isLaterPage(normalizedContext)) return;
            latestBaseScope = contextScope(normalizedContext);
            latestBaseSequence = sequence;
        }

        function isActive(context, sequence) {
            const scope = contextScope(context);
            if (sequence === 0) return latestBaseSequence === 0;
            if (isLaterPage(context)) {
                if (latestBaseScope) return scope === latestBaseScope && sequence > latestBaseSequence;
                return activeScope === null || scope === activeScope;
            }
            return scope === latestBaseScope && sequence >= latestBaseSequence;
        }

        function ingestItems(items, context = null, requestSequence = 0, { authoritative = false } = {}) {
            if (!Array.isArray(items)) return false;
            const sequence = Number.isSafeInteger(requestSequence) && requestSequence >= 0
                ? requestSequence
                : 0;
            const normalizedContext = sanitizeContext(context, target.location.origin);
            if (!normalizedContext || !isActive(normalizedContext, sequence)) return false;
            const scope = contextScope(normalizedContext);
            const batch = new Map();
            for (const item of items) {
                const product = sanitizeProduct(item);
                if (!product) continue;
                product.requestSequence = sequence;
                if (batch.has(product.id)) batch.delete(product.id);
                batch.set(product.id, product);
                while (batch.size > limit) batch.delete(batch.keys().next().value);
            }
            const laterPage = isLaterPage(normalizedContext);
            if (batch.size === 0 && (!authoritative || laterPage)) return false;
            if (scope !== activeScope) {
                cache.clear();
                activeScope = scope;
            }

            if (!laterPage) {
                const newerEntries = [...cache.entries()].filter(([, product]) => product.requestSequence > sequence);
                cache.clear();
                for (const [id, product] of newerEntries) cache.set(id, product);
            }
            activeContext = normalizedContext;
            activeContextSequence = Math.max(activeContextSequence, sequence);

            const accepted = new Map();
            for (const [id, product] of batch) {
                const cached = cache.get(id);
                if (cached && cached.requestSequence > sequence) continue;
                if (cache.has(id)) cache.delete(id);
                cache.set(id, product);
                accepted.set(id, product);
                while (cache.size > limit) cache.delete(cache.keys().next().value);
            }
            revision += 1;
            const mode = laterPage ? 'batch' : 'snapshot';
            post(mode, laterPage ? accepted : cache, normalizedContext);
            report(target, 'info', 'captured sanitized search products', {
                revision,
                query: normalizedContext && normalizedContext.query,
                page: normalizedContext && normalizedContext.page,
                receivedProducts: items.length,
                acceptedProducts: accepted.size,
                cachedProducts: cache.size,
                requestSequence: sequence
            });
            return true;
        }

        function handleMessage(event) {
            if (!event || event.source !== target || event.origin !== target.location.origin) return;
            const message = event.data;
            if (!message || message.source !== SOURCE || message.version !== VERSION || message.type !== REQUEST_TYPE) return;
            post('snapshot', cache, activeContext);
        }

        return {
            handleMessage,
            ingestItems,
            noteRequest,
            snapshot() { return productsArray(cache); },
            context() { return activeContext; },
            revision() { return revision; }
        };
    }

    function captureInitialNextData(target, channel, onPayload = null) {
        const element = target.document && target.document.getElementById
            ? target.document.getElementById('__NEXT_DATA__')
            : null;
        if (!element) return false;
        try {
            const text = element.textContent || '';
            if (!text || text.length > MAX_PRELOADED_TEXT_LENGTH) return false;
            const payload = JSON.parse(text);
            if (typeof onPayload === 'function') onPayload(payload);
            const products = collectItemStackProducts(payload, ['itemsV2', 'items']);
            const context = initialNextDataContext(target, payload);
            if (!context) return false;
            const ingested = channel.ingestItems(
                products,
                context,
                0,
                { authoritative: true }
            );
            if (!ingested) return false;
            report(target, 'info', 'read initial search products from __NEXT_DATA__', {
                products: products.length
            });
            return true;
        } catch (error) {
            report(target, 'error', 'failed to parse initial __NEXT_DATA__', errorDetails(error));
            return false;
        }
    }

    function installCapture(target, options = {}) {
        if (!target || !target.location || !target.document || typeof target.fetch !== 'function') return null;
        if (target[INSTALL_KEY]) return target[INSTALL_KEY];

        const channel = createProductChannel(target, options.cacheLimit || CACHE_LIMIT);
        const nativeFetch = target.fetch;
        const baseHref = target.location.href;
        const expectedOrigin = target.location.origin;
        const HeadersConstructor = target.Headers || (typeof Headers === 'function' ? Headers : null);
        const cartProducts = new Map();
        let nextRequestSequence = 1;
        let searchTemplate = null;
        let cartQueryTemplate = null;
        let cartUpdateUrl = new URL(CART_UPDATE_SEED_PATH, expectedOrigin).href;
        let cartSnapshot = null;

        function selectedStoreIdentity() {
            const values = [];
            try {
                const pairs = String(target.document.cookie || '').split(';');
                for (const pair of pairs) {
                    const separator = pair.indexOf('=');
                    if (separator < 0) continue;
                    const key = pair.slice(0, separator).trim();
                    if (!/^(?:assortmentStoreId|deliveryCatchment|defaultNearestStoreId)$/.test(key)) continue;
                    const value = normalizedStoreIdentity(decodeURIComponent(pair.slice(separator + 1).trim()));
                    if (value) values.push(value);
                }
            } catch (_error) {
                return null;
            }
            const unique = [...new Set(values)];
            return unique.length === 1 ? unique[0] : null;
        }

        function headerEntries(request, init) {
            if (!HeadersConstructor) return [];
            try {
                const headers = new HeadersConstructor(request && typeof request === 'object' ? request.headers : undefined);
                if (init && init.headers) {
                    const overrides = new HeadersConstructor(init.headers);
                    overrides.forEach((value, key) => headers.set(key, value));
                }
                return [...headers.entries()].slice(0, 100);
            } catch (_error) {
                return [];
            }
        }

        function requestTemplate(url, request, init) {
            const source = request && typeof request === 'object' ? request : {};
            const overrides = init && typeof init === 'object' ? init : {};
            return Object.freeze({
                url: url.href,
                headers: headerEntries(source, overrides),
                credentials: overrides.credentials || source.credentials || 'include',
                mode: overrides.mode || source.mode || null,
                redirect: overrides.redirect || source.redirect || null,
                referrer: overrides.referrer || source.referrer || null,
                referrerPolicy: overrides.referrerPolicy || source.referrerPolicy || null,
                integrity: overrides.integrity || source.integrity || null,
                cache: overrides.cache || source.cache || null,
                storeId: selectedStoreIdentity()
            });
        }

        function requestHeaders(template, operation) {
            const entries = template?.headers || [];
            if (!HeadersConstructor) return Object.fromEntries(entries);
            const headers = new HeadersConstructor(entries);
            // Request/trace IDs belong to the observed request. Reusing them
            // can make Walmart's edge return a stale cart view after a valid
            // mutation, so every replay gets a fresh correlation identity.
            headers.delete('baggage');
            headers.delete('traceparent');
            headers.delete('wm_qos.correlation_id');
            headers.delete('x-latency-trace');
            headers.delete('x-o-correlation-id');
            let correlationId = null;
            try { correlationId = target.crypto?.randomUUID?.() || null; } catch (_error) { /* optional */ }
            if (correlationId) {
                headers.set('wm_qos.correlation_id', correlationId);
                headers.set('x-o-correlation-id', correlationId);
            }
            // Walmart rejects otherwise same-origin requests without this small
            // operation identity. Browser-managed cookies remain automatic and
            // are never copied, logged, posted, or exposed through the API.
            headers.set('content-type', 'application/json');
            headers.set('accept-language', 'en-CA');
            headers.set('tenant-id', 'qxjed8');
            headers.set('x-apollo-operation-name', operation);
            const operationType = operation === 'Search' || operation === 'MergeAndGetCart'
                ? 'query'
                : 'mutation';
            headers.set('x-o-gql-query', `${operationType} ${operation}`);
            headers.set('x-o-bu', 'WALMART-CA');
            headers.set('x-o-mart', 'B2C');
            headers.set('x-o-platform', 'rweb');
            headers.set('x-o-segment', 'oaoh');
            headers.set('wm_page_url', `${target.location.pathname || '/'}${target.location.search || ''}`);
            return headers;
        }

        function fetchOptions(template, operation, body = null) {
            return {
                method: body === null ? 'GET' : 'POST',
                headers: requestHeaders(template, operation),
                credentials: template?.credentials || 'include',
                ...(body === null ? {} : { body }),
                ...(template?.mode ? { mode: template.mode } : {}),
                ...(template?.redirect ? { redirect: template.redirect } : {}),
                ...(template?.referrer ? { referrer: template.referrer } : {}),
                ...(template?.referrerPolicy ? { referrerPolicy: template.referrerPolicy } : {}),
                ...(template?.integrity ? { integrity: template.integrity } : {}),
                ...(template?.cache ? { cache: template.cache } : {})
            };
        }

        function deepCloneJson(value) {
            try { return JSON.parse(JSON.stringify(value)); } catch (_error) { return null; }
        }

        function rememberSearchTemplate(url, request, init) {
            try {
                const variables = JSON.parse(url.searchParams.get('variables') || 'null');
                if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return;
                searchTemplate = Object.freeze({
                    ...requestTemplate(url, request, init),
                    variables: deepCloneJson(variables)
                });
            } catch (_error) {
                // An unparseable request can still feed the passive sorter but
                // cannot become a Cart Builder replay template.
            }
        }

        function seedSearchTemplate(payload) {
            if (searchTemplate) return;
            const variables = payload?.props?.pageProps?.initialSearchQueryVariables;
            if (!variables || typeof variables !== 'object' || Array.isArray(variables)) return;
            const url = new URL(SEARCH_SEED_PATH, expectedOrigin);
            url.searchParams.set('variables', JSON.stringify(variables));
            searchTemplate = Object.freeze({
                ...requestTemplate(url, null, null),
                variables: deepCloneJson(variables)
            });
        }

        function rewriteSearchUrl(template, query) {
            const normalized = cleanText(query, 120);
            const variables = deepCloneJson(template?.variables);
            if (!normalized || !variables) return null;
            variables.query = normalized;
            variables.page = 1;
            if (variables.searchArgs && typeof variables.searchArgs === 'object') {
                variables.searchArgs.query = normalized;
            }
            if (variables.searchParams && typeof variables.searchParams === 'object') {
                variables.searchParams.query = normalized;
                variables.searchParams.page = 1;
                if (variables.searchParams.searchArgs && typeof variables.searchParams.searchArgs === 'object') {
                    variables.searchParams.searchArgs.query = normalized;
                }
            }
            try {
                const url = new URL(template.url);
                url.searchParams.set('variables', JSON.stringify(variables));
                return url;
            } catch (_error) {
                return null;
            }
        }

        function cartKey(offerId, usItemId) {
            const offer = cleanScalar(offerId, 160);
            const item = cleanScalar(usItemId, 160);
            return offer === null || item === null
                ? null
                : `w:${encodeURIComponent(String(item))}:${encodeURIComponent(String(offer))}`;
        }

        function cartKeyParts(value) {
            const key = cleanText(value, 400);
            if (!key || !key.startsWith('w:')) return null;
            const parts = key.slice(2).split(':');
            if (parts.length !== 2) return null;
            try {
                const usItemId = cleanText(decodeURIComponent(parts[0]), 160);
                const offerId = cleanText(decodeURIComponent(parts[1]), 160);
                return usItemId && offerId ? { key, usItemId, offerId } : null;
            } catch (_error) {
                return null;
            }
        }

        function rememberCartProducts(products) {
            for (const item of products) {
                const product = sanitizeProduct(item);
                if (!product?.cartKey) continue;
                if (cartProducts.has(product.cartKey)) cartProducts.delete(product.cartKey);
                cartProducts.set(product.cartKey, product);
                while (cartProducts.size > CACHE_LIMIT) cartProducts.delete(cartProducts.keys().next().value);
            }
        }

        function sanitizedCart(payload, expectedCartId = null) {
            if (!payload || typeof payload !== 'object') return null;
            const pending = [payload];
            const seen = new WeakSet();
            let inspected = 0;
            while (pending.length && inspected < MAX_WALK_NODES) {
                const value = pending.shift();
                if (!value || typeof value !== 'object' || seen.has(value)) continue;
                seen.add(value);
                inspected += 1;
                const id = cleanText(value.id, 256);
                if (id && Array.isArray(value.lineItems) && value.lineItems.length <= MAX_CART_LINES) {
                    if (expectedCartId && id !== expectedCartId) return null;
                    const lines = new Map();
                    for (const line of value.lineItems) {
                        const product = line && line.product;
                        const key = cartKey(product?.offerId, product?.usItemId);
                        if (!key) continue;
                        const fulfillmentQuantity = Array.isArray(line.fulfillmentDetails)
                            ? line.fulfillmentDetails.reduce((sum, detail) => sum + (cleanNumber(detail?.quantity) || 0), 0)
                            : 0;
                        const quantity = cleanNumber(line.quantity) || cleanNumber(line.qty) || fulfillmentQuantity || 1;
                        lines.set(key, Math.max(lines.get(key) || 0, quantity));
                    }
                    return Object.freeze({ id, lines, storeId: selectedStoreIdentity() });
                }
                let visited = 0;
                for (const key in value) {
                    if (visited >= MAX_CONTAINER_ENTRIES) break;
                    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
                    visited += 1;
                    const nested = value[key];
                    if (nested && typeof nested === 'object') pending.push(nested);
                }
            }
            return null;
        }

        function acceptCartPayload(payload, expectedCartId = null) {
            const next = sanitizedCart(payload, expectedCartId);
            if (!next) return null;
            cartSnapshot = next;
            return next;
        }

        function cloneJsonResponse(response) {
            if (!response || typeof response.clone !== 'function') return null;
            try { return response.clone(); } catch (_error) { return null; }
        }

        function captureResponse(response, context, requestSequence) {
            if (!response || typeof response.clone !== 'function') return;
            if (response.ok === false || (typeof response.status === 'number' && response.status !== 0
                && (response.status < 200 || response.status >= 300))) {
                report(target, 'warn', 'ignored unsuccessful Walmart search response', {
                    query: context.query,
                    requestSequence,
                    status: response.status
                });
                return;
            }
            if (response.url) {
                const finalUrl = allowedSearchUrl(response.url, baseHref, expectedOrigin);
                const finalContext = finalUrl
                    ? requestContext(finalUrl, context.pageUrlAtRequest, expectedOrigin)
                    : null;
                if (!finalContext || finalContext.query !== context.query || finalContext.page !== context.page
                    || finalContext.storeId !== context.storeId
                    || finalContext.variablesFingerprint !== context.variablesFingerprint) {
                    report(target, 'warn', 'ignored Walmart search response with changed request identity', {
                        query: context.query,
                        requestSequence
                    });
                    return;
                }
            }
            const contentType = response.headers?.get?.('content-type') || '';
            if (contentType && !/\bjson\b/i.test(contentType)) return;
            const captureLocation = queryAndPageFromUrl(target.location.href, expectedOrigin);
            context.pageUrlAtCapture = captureLocation.pagePath;
            const clonedResponse = cloneJsonResponse(response);
            if (!clonedResponse) return;

            void Promise.resolve(clonedResponse.json())
                .then(payload => {
                    const products = collectItemStackProducts(payload, ['itemsV2']);
                    rememberCartProducts(products);
                    channel.ingestItems(products, context, requestSequence, { authoritative: true });
                })
                .catch(error => report(target, 'error', 'failed to parse Walmart search response', {
                    ...errorDetails(error), query: context.query, requestSequence
                }));
        }

        async function requestBodyText(request, init) {
            if (typeof init?.body === 'string') return init.body;
            if (!request || typeof request !== 'object' || typeof request.clone !== 'function') return null;
            try { return await request.clone().text(); } catch (_error) { return null; }
        }

        function observeCartResponse(response, expectedCartId = null) {
            if (!response?.ok) return;
            const clone = cloneJsonResponse(response);
            if (!clone) return;
            void Promise.resolve(clone.json())
                .then(payload => acceptCartPayload(payload, expectedCartId))
                .catch(error => report(target, 'warn', 'ignored unreadable Walmart cart response', errorDetails(error)));
        }

        function wrappedFetch(...args) {
            const responsePromise = Reflect.apply(nativeFetch, this, args);
            const searchUrl = allowedSearchUrl(args[0], baseHref, expectedOrigin);
            const cartQueryUrl = allowedApiUrl(args[0], baseHref, expectedOrigin, CART_QUERY_PATH);
            const cartMutationUrl = allowedApiUrl(args[0], baseHref, expectedOrigin, CART_UPDATE_PATH);

            if (searchUrl) {
                const requestSequence = nextRequestSequence;
                nextRequestSequence += 1;
                const context = requestContext(searchUrl, target.location.href, expectedOrigin);
                if (context) {
                    rememberSearchTemplate(searchUrl, args[0], args[1]);
                    channel.noteRequest(context, requestSequence);
                    void Promise.resolve(responsePromise)
                        .then(response => captureResponse(response, context, requestSequence))
                        .catch(error => report(target, 'warn', 'Walmart search request rejected before capture', {
                            ...errorDetails(error), query: context.query, requestSequence
                        }));
                }
            }

            if (cartQueryUrl) {
                cartQueryTemplate = requestTemplate(cartQueryUrl, args[0], args[1]);
                void Promise.resolve(responsePromise).then(response => observeCartResponse(response)).catch(() => {});
            }

            if (cartMutationUrl) {
                cartUpdateUrl = cartMutationUrl.href;
                void Promise.resolve(requestBodyText(args[0], args[1])).then(text => {
                    try {
                        const body = JSON.parse(text || 'null');
                        const expectedCartId = cleanText(body?.variables?.input?.cartId, 256);
                        void Promise.resolve(responsePromise)
                            .then(response => observeCartResponse(response, expectedCartId))
                            .catch(() => {});
                    } catch (_error) { /* malformed bodies never become cart evidence */ }
                });
            }
            return responsePromise;
        }

        async function probeCart() {
            const template = cartQueryTemplate;
            if (!template || (template.storeId && template.storeId !== selectedStoreIdentity())) return null;
            try {
                const options = fetchOptions(template, 'MergeAndGetCart');
                options.cache = 'no-store';
                const response = await nativeFetch.call(target, template.url, options);
                if (!response?.ok) return null;
                return acceptCartPayload(await response.json());
            } catch (_error) {
                return null;
            }
        }

        async function verifyPersistedCart(productKey, minimumQuantity) {
            // updateItems is eventually visible through MergeAndGetCart, and
            // the web client normally bridges that delay with its local Apollo
            // cache. The userscript has no reason to mutate site state, so it
            // performs a short bounded server verification instead.
            for (const delay of [0, 250, 750, 1500, 3000]) {
                if (delay && typeof target.setTimeout === 'function') {
                    await new Promise(resolve => target.setTimeout(resolve, delay));
                }
                const current = await probeCart();
                if (current && (current.lines.get(productKey) || 0) >= minimumQuantity) return current;
            }
            return null;
        }

        async function queryProducts(query) {
            const wanted = normalizeQuery(query);
            const active = channel.context();
            if (wanted && active?.query === wanted) {
                const cached = channel.snapshot();
                if (cached.length) {
                    rememberCartProducts(cached);
                    return { status: 'complete', products: cached };
                }
            }
            const template = searchTemplate;
            if (!wanted || !template || (template.storeId && template.storeId !== selectedStoreIdentity())) return null;
            const url = rewriteSearchUrl(template, query);
            if (!url) return null;
            try {
                const response = await nativeFetch.call(target, url.href, fetchOptions(template, 'Search'));
                if (response?.status === 403 || response?.status === 412) {
                    return { status: 'human-required', reason: 'Walmart needs human verification. Complete it in the page, then retry.' };
                }
                if (!response?.ok) return null;
                const payload = await response.json();
                if (Array.isArray(payload?.errors) && payload.errors.length) return null;
                const rawProducts = collectItemStackProducts(payload, ['itemsV2']);
                rememberCartProducts(rawProducts);
                return { status: 'complete', products: rawProducts.map(sanitizeProduct).filter(Boolean) };
            } catch (_error) {
                return null;
            }
        }

        async function addProduct(productKey, options = {}) {
            const parts = cartKeyParts(productKey);
            if (!parts) return { status: 'failed', reason: 'Walmart did not return an exact product offer.' };
            const product = cartProducts.get(parts.key);
            const name = cleanText(product?.name || options?.name, 1000);
            if (!name) return { status: 'failed', reason: 'Walmart did not return an exact product name.' };
            let currentCart = cartSnapshot;
            if (!currentCart) currentCart = await probeCart();
            if (!currentCart || (currentCart.storeId && currentCart.storeId !== selectedStoreIdentity())) return null;
            const previousQuantity = currentCart.lines.get(parts.key) || 0;
            const quantity = previousQuantity + 1;
            const body = JSON.stringify({
                variables: {
                    input: {
                        enableLiquorBox: false,
                        cartId: currentCart.id,
                        items: [{
                            offerId: parts.offerId,
                            quantity,
                            usItemId: parts.usItemId,
                            additionalInfo: { addOnServices: [] },
                            name
                        }],
                        skipPolicyCheck: false,
                        enableCartSplitClarity: true,
                        features: ['lmpdel']
                    }
                }
            });
            // A bare updateItems call can return an optimistic cart-shaped
            // response without persisting it to Walmart's active web cart.
            // Require the current MergeAndGetCart request context (notably its
            // opaque x-o-ccm value) and replay those headers into the mutation.
            if (!cartQueryTemplate) return null;
            const template = Object.freeze({ ...cartQueryTemplate, url: cartUpdateUrl });
            try {
                const response = await nativeFetch.call(target, cartUpdateUrl, fetchOptions(template, 'updateItems', body));
                if (response?.status === 403 || response?.status === 412) {
                    return { status: 'human-required', reason: 'Walmart needs human verification. Complete it in the page, then retry.' };
                }
                if (!response?.ok) return null;
                const payload = await response.json();
                if (Array.isArray(payload?.errors) && payload.errors.length) {
                    return { status: 'failed', reason: 'Walmart did not confirm this cart update.' };
                }
                const optimistic = acceptCartPayload(payload, currentCart.id);
                if (!optimistic || (optimistic.lines.get(parts.key) || 0) < quantity) {
                    return { status: 'failed', reason: 'Walmart did not confirm this item in the cart.' };
                }
                // Walmart can return an optimistic updateItems payload even
                // when its active web cart was not persisted. A fresh
                // MergeAndGetCart response is the only success evidence used
                // by the runner and its final review.
                const verified = await verifyPersistedCart(parts.key, quantity);
                if (!verified) {
                    return { status: 'failed', reason: 'Walmart did not confirm this item in the cart.' };
                }
                return { status: 'added' };
            } catch (_error) {
                return null;
            }
        }

        async function readCart(productKeys = []) {
            const currentCart = await probeCart();
            if (!currentCart || (currentCart.storeId && currentCart.storeId !== selectedStoreIdentity())) return null;
            const requested = productKeys.map(cartKeyParts).filter(Boolean).map(item => item.key);
            return {
                inspectable: true,
                presentProductIds: requested.filter(key => (currentCart.lines.get(key) || 0) > 0)
            };
        }

        target.fetch = wrappedFetch;
        target.addEventListener('message', channel.handleMessage);
        report(target, 'info', 'main-world capture hook installed', {
            page: safePagePath(target.location.href, expectedOrigin)
        });

        let initialDataCaptured = false;
        function captureNextDataOnce() {
            if (initialDataCaptured) return;
            initialDataCaptured = captureInitialNextData(target, channel, payload => {
                seedSearchTemplate(payload);
                rememberCartProducts(collectItemStackProducts(payload, ['itemsV2', 'items']));
                acceptCartPayload(payload);
            });
        }

        if (target.document.readyState === 'loading') {
            target.document.addEventListener('DOMContentLoaded', captureNextDataOnce, { once: true });
        } else {
            Promise.resolve().then(captureNextDataOnce);
        }

        const installation = {
            channel,
            queryProducts,
            addProduct,
            readCart,
            nativeFetch,
            wrappedFetch,
            captureNextDataOnce
        };
        try {
            Object.defineProperty(target, INSTALL_KEY, { value: installation, configurable: false });
        } catch (_error) {
            target[INSTALL_KEY] = installation;
        }
        return installation;
    }

    const api = {
        CACHE_LIMIT,
        PRODUCTS_TYPE,
        REQUEST_TYPE,
        SOURCE,
        VERSION,
        LOG_PREFIX,
        allowedSearchUrl,
        captureInitialNextData,
        cleanUnitPrice,
        collectItemStackProducts,
        initialNextDataContext,
        normalizePage,
        normalizeQuery,
        queryAndPageFromUrl,
        requestContext,
        safePagePath,
        sanitizeContext,
        createProductChannel,
        installCapture,
        sanitizeProduct
    };

    void api;
    return global ? installCapture(global) : false;
}
