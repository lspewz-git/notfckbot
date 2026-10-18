/**
 * In-memory caches, all built the same way on lru-cache: bounded by `max` (the least recently
 * used entry goes first), entries expire after `ttl`, and with a `fetchMethod` concurrent
 * fetches of one key share one request.
 */
const { LRUCache } = require('lru-cache');

/**
 * @template {{}} K, V
 * @param {LRUCache.Options<K, V, unknown>} options
 * @returns {LRUCache<K, V>}
 */
const lruCache = (options) =>
    new LRUCache({
        // A failed refresh keeps the previous answer instead of dropping it
        noDeleteOnFetchRejection: true,
        // An entry pushed out while its fetch runs still answers whoever is waiting for it
        ignoreFetchAbort: true,
        // Date's clock, read on every call: tests move it by stubbing Date.now
        perf: Date,
        ttlResolution: 0,
        ...options
    });

/**
 * `cache.fetch` that answers at once with the entry being refreshed while it is still fresh,
 * and waits for the fetch once it has expired (or was never there).
 * @template {{}} K, V
 * @param {LRUCache<K, V>} cache
 * @param {K} key
 * @returns {Promise<V>}
 */
const fetchFresh = (cache, key) => cache.fetch(key, { allowStale: cache.getRemainingTTL(key) > 0 });

module.exports = { lruCache, fetchFresh };
