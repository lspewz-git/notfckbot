/**
 * Makes axios's `timeout` cover the whole request. On its own it starts counting only once the
 * socket is there, and through a proxy the socket comes after the connection to the proxy: a
 * proxy that doesn't answer (a dropped packet, a dead host) held requests for 30 s (SOCKS) or
 * over two minutes (HTTP), whatever the timeout said. An abort signal set to the same timeout
 * ends the request at that moment wherever it is, and the error looks like axios's own timeout
 * (ECONNABORTED), so the code that handles timeouts needs no change.
 */
const axios = require('axios');

const installed = new WeakSet();

/** Adds the deadline to an axios instance (the default one, or one from axios.create). */
function installDeadline(instance) {
    if (installed.has(instance)) return instance;
    installed.add(instance);
    instance.interceptors.request.use((config) => {
        if (config.timeout && !config.signal) {
            config.signal = AbortSignal.timeout(config.timeout);
            config.deadlineMs = config.timeout;
        }
        return config;
    });
    instance.interceptors.response.use(undefined, (err) => {
        const config = err && err.config;
        if (axios.isCancel(err) && config && config.deadlineMs && config.signal && config.signal.aborted) {
            err.code = 'ECONNABORTED';
            err.message = `timeout of ${config.deadlineMs}ms exceeded`;
        }
        return Promise.reject(err);
    });
    return instance;
}

module.exports = { installDeadline };
