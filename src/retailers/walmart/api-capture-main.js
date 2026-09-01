/*!
 * Walmart page-world search observer. Installed at document-start, it watches
 * Walmart's bounded GraphQL search responses and bootstrap cache without
 * initiating requests or reading credentials. Sanitized records are scoped to
 * the current route and published only after response/sequence checks pass.
 */
(function initializeApiCapture(global) {
    'use strict';

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
        return {
            query: pageLocation.query ?? normalizeQuery(variables && variables.query),
            page: pageLocation.page ?? normalizePage(variables && variables.page),
            storeId: storeIdentityFromPage(target.location && target.location.href, expectedOrigin)
                || storeIdentityFromVariables(variables).value,
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

        return {
            id: key,
            name,
            price: cleanNumber(rawPrice),
            averagePrice,
            unitPrice: cleanUnitPrice(item.priceInfo && item.priceInfo.unitPrice),
            variableOptions,
            currentVariantConfirmed: variantInfo.currentVariantConfirmed,
            currentVariantName: variantInfo.currentVariantName
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

    function captureInitialNextData(target, channel) {
        const element = target.document && target.document.getElementById
            ? target.document.getElementById('__NEXT_DATA__')
            : null;
        if (!element) return false;
        try {
            const text = element.textContent || '';
            if (!text || text.length > MAX_PRELOADED_TEXT_LENGTH) return false;
            const payload = JSON.parse(text);
            const products = collectItemStackProducts(payload, ['itemsV2', 'items']);
            channel.ingestItems(
                products,
                initialNextDataContext(target, payload),
                0,
                { authoritative: true }
            );
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
        let nextRequestSequence = 1;

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
            if (contentType && !/\bjson\b/i.test(contentType)) {
                report(target, 'warn', 'ignored non-JSON Walmart search response', {
                    query: context.query,
                    requestSequence
                });
                return;
            }

            const captureLocation = queryAndPageFromUrl(target.location.href, expectedOrigin);
            context.pageUrlAtCapture = captureLocation.pagePath;

            let clonedResponse;
            try {
                clonedResponse = response.clone();
            } catch (error) {
                report(target, 'error', 'failed to clone Walmart search response', {
                    ...errorDetails(error),
                    query: context.query,
                    requestSequence
                });
                return;
            }

            void Promise.resolve()
                .then(() => clonedResponse.json())
                .then(payload => {
                    const products = collectItemStackProducts(payload, ['itemsV2']);
                    channel.ingestItems(products, context, requestSequence, { authoritative: true });
                })
                .catch(error => report(target, 'error', 'failed to parse Walmart search response', {
                    ...errorDetails(error),
                    query: context.query,
                    requestSequence
                }));
        }

        function wrappedFetch(...args) {
            const responsePromise = Reflect.apply(nativeFetch, this, args);
            const requestUrl = allowedSearchUrl(args[0], baseHref, expectedOrigin);
            if (!requestUrl) return responsePromise;
            const requestSequence = nextRequestSequence;
            nextRequestSequence += 1;
            const context = requestContext(requestUrl, target.location.href, expectedOrigin);
            if (!context) {
                report(target, 'warn', 'ignored Walmart search request with mismatched store context', {
                    requestSequence
                });
                return responsePromise;
            }
            channel.noteRequest(context, requestSequence);
            report(target, 'info', 'observed Walmart search request', {
                query: context.query,
                page: context.page,
                requestSequence
            });

            void Promise.resolve(responsePromise)
                .then(response => captureResponse(response, context, requestSequence))
                .catch(error => report(target, 'warn', 'Walmart search request rejected before capture', {
                    ...errorDetails(error),
                    query: context.query,
                    requestSequence
                }));
            return responsePromise;
        }

        target.fetch = wrappedFetch;
        target.addEventListener('message', channel.handleMessage);
        report(target, 'info', 'main-world capture hook installed', {
            page: safePagePath(target.location.href, expectedOrigin)
        });

        let initialDataCaptured = false;
        function captureNextDataOnce() {
            if (initialDataCaptured) return;
            initialDataCaptured = captureInitialNextData(target, channel);
        }

        if (target.document.readyState === 'loading') {
            target.document.addEventListener('DOMContentLoaded', captureNextDataOnce, { once: true });
        } else {
            Promise.resolve().then(captureNextDataOnce);
        }

        const installation = { channel, nativeFetch, wrappedFetch, captureNextDataOnce };
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
    if (global) installCapture(global);
})(typeof window === 'object' ? window : null);
