// Safari does not support Chromium's content_scripts[].world manifest key.
// The isolated-world copy injects this same bundled file into the page world;
// the page-world copy has no extension runtime and skips this bootstrap.
(function injectPageWorldCapture(global) {
    const runtime = global.browser?.runtime || global.chrome?.runtime;
    const root = global.document?.documentElement;
    if (!runtime?.getURL || !root || root.dataset.wppuApiCaptureInjected) return;
    root.dataset.wppuApiCaptureInjected = 'true';
    const script = global.document.createElement('script');
    script.src = runtime.getURL('walmart-api-capture-main.js');
    script.async = false;
    script.addEventListener('load', () => script.remove(), { once: true });
    script.addEventListener('error', () => {
        delete root.dataset.wppuApiCaptureInjected;
        script.remove();
    }, { once: true });
    root.prepend(script);
})(globalThis);

// Runs in Walmart's main page world at document_start. It observes Walmart's
// own search requests; it never makes a request or reads request credentials.
(function initializeApiCapture(global) {
    'use strict';

    const SOURCE = 'walmart-price-per-unit';
    const VERSION = 1;
    const PRODUCTS_TYPE = 'api-products';
    const REQUEST_TYPE = 'api-products-request';
    const CACHE_LIMIT = 500;
    const MAX_WALK_NODES = 20000;
    const MAX_EXTRACTED_ITEMS = 2000;
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
        if (typeof value === 'number') return Number.isFinite(value) ? value : null;
        if (typeof value !== 'string') return null;
        const normalized = value.trim().replace(/,/g, '');
        if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return null;
        const number = Number(normalized);
        return Number.isFinite(number) ? number : null;
    }

    function cleanDisplayedPrice(value) {
        const number = cleanNumber(value);
        if (number !== null) return number;
        const text = cleanText(value, 64);
        if (text === null) return null;
        const cents = text.match(/^(\d+(?:\.\d+)?)\s*¢$/);
        if (cents) return Number(cents[1]) / 100;
        const dollars = text.match(/^\$\s*(\d+(?:,\d{3})*)(?:\.(\d{2}))?$/);
        if (!dollars) return null;
        return Number(`${dollars[1].replace(/,/g, '')}.${dollars[2] || '00'}`);
    }

    function cleanUnitPrice(value) {
        if (typeof value === 'string') return cleanText(value, 128);
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

        const price = cleanScalar(value.price);
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

    function requestContext(requestUrl, pageUrlAtRequest, expectedOrigin) {
        let variables = null;
        try {
            const encodedVariables = requestUrl.searchParams.get('variables');
            if (encodedVariables) variables = JSON.parse(encodedVariables);
        } catch (_error) {
            variables = null;
        }

        const pageLocation = queryAndPageFromUrl(pageUrlAtRequest, expectedOrigin);
        return {
            query: normalizeQuery(variables && variables.query) ?? pageLocation.query,
            page: normalizePage(variables && variables.page) ?? pageLocation.page,
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
            pageUrlAtRequest: pageLocation.pagePath,
            pageUrlAtCapture: pageLocation.pagePath
        };
    }

    function sanitizeContext(context, expectedOrigin) {
        if (!context || typeof context !== 'object') return null;
        return {
            query: normalizeQuery(context.query),
            page: normalizePage(context.page),
            pageUrlAtRequest: safePagePath(context.pageUrlAtRequest, expectedOrigin),
            pageUrlAtCapture: safePagePath(context.pageUrlAtCapture, expectedOrigin)
        };
    }

    function contextScope(context) {
        if (context && context.query !== null) return `query:${context.query}`;
        if (context && context.pageUrlAtRequest !== null) return `page:${context.pageUrlAtRequest}`;
        return 'unknown';
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

        while (pendingIndex < pending.length && inspected < MAX_WALK_NODES && products.length < MAX_EXTRACTED_ITEMS) {
            const value = pending[pendingIndex];
            pendingIndex += 1;
            if (!value || typeof value !== 'object' || seen.has(value)) continue;
            seen.add(value);
            inspected += 1;

            if (Array.isArray(value)) {
                for (const child of value) pending.push(child);
                continue;
            }

            if (Array.isArray(value.itemStacks)) {
                for (const itemStack of value.itemStacks) {
                    if (!itemStack || typeof itemStack !== 'object') continue;
                    let stackItems = null;
                    for (const itemKey of allowedItemKeys) {
                        if (!Array.isArray(itemStack[itemKey])) continue;
                        stackItems = itemStack[itemKey];
                        break;
                    }
                    if (stackItems) {
                        for (const item of stackItems) {
                            products.push(item);
                            if (products.length >= MAX_EXTRACTED_ITEMS) break;
                        }
                    }
                    if (products.length >= MAX_EXTRACTED_ITEMS) break;
                }
            }

            for (const [key, child] of Object.entries(value)) {
                if (key !== 'itemStacks' && child && typeof child === 'object') pending.push(child);
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

    function productsObject(entries) {
        const products = Object.create(null);
        for (const [id, product] of entries) products[id] = product;
        return products;
    }

    function createProductChannel(target, cacheLimit = CACHE_LIMIT) {
        const limit = Math.max(1, Math.floor(cacheLimit));
        const cache = new Map();
        let revision = 0;
        let activeScope = null;
        let activeContext = null;
        let activeContextSequence = -1;

        function post(mode, entries, context) {
            const message = {
                source: SOURCE,
                version: VERSION,
                type: PRODUCTS_TYPE,
                mode,
                revision,
                context,
                products: productsObject(entries)
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

        function ingestItems(items, context = null, requestSequence = 0) {
            if (!Array.isArray(items) || items.length === 0) return;
            const sequence = Number.isSafeInteger(requestSequence) && requestSequence >= 0
                ? requestSequence
                : 0;
            const normalizedContext = sanitizeContext(context, target.location.origin);
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
            if (batch.size === 0) return;

            if (activeScope !== null && scope !== activeScope && sequence < activeContextSequence) {
                report(target, 'debug', 'ignored late response from an older search', {
                    query: normalizedContext && normalizedContext.query,
                    requestSequence: sequence,
                    activeRequestSequence: activeContextSequence
                });
                return;
            }
            if (scope !== activeScope) {
                cache.clear();
                activeScope = scope;
                activeContext = normalizedContext;
                activeContextSequence = sequence;
            } else if (sequence >= activeContextSequence) {
                activeContext = normalizedContext;
                activeContextSequence = sequence;
            }

            const accepted = new Map();
            for (const [id, product] of batch) {
                const cached = cache.get(id);
                if (cached && cached.requestSequence > sequence) continue;
                if (cache.has(id)) cache.delete(id);
                cache.set(id, product);
                accepted.set(id, product);
                while (cache.size > limit) cache.delete(cache.keys().next().value);
            }
            if (accepted.size === 0) return;
            revision += 1;
            post('batch', accepted, normalizedContext);
            report(target, 'info', 'captured sanitized search products', {
                revision,
                query: normalizedContext && normalizedContext.query,
                page: normalizedContext && normalizedContext.page,
                receivedProducts: items.length,
                acceptedProducts: accepted.size,
                cachedProducts: cache.size,
                requestSequence: sequence
            });
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
            snapshot() { return productsObject(cache); },
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
            const payload = JSON.parse(element.textContent || '');
            const products = collectItemStackProducts(payload, ['itemsV2', 'items']);
            channel.ingestItems(
                products,
                initialNextDataContext(target, payload),
                0
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

        function captureResponse(response, requestUrl, context, requestSequence) {
            if (!response || typeof response.clone !== 'function') return;
            if (response.url && !allowedSearchUrl(response.url, baseHref, expectedOrigin)) {
                report(target, 'warn', 'ignored search response redirected outside the allowlist', {
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
                    channel.ingestItems(products, context, requestSequence);
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
            report(target, 'info', 'observed Walmart search request', {
                query: context.query,
                page: context.page,
                requestSequence
            });

            void Promise.resolve(responsePromise)
                .then(response => captureResponse(response, requestUrl, context, requestSequence))
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
