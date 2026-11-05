const { test, expect } = require('@playwright/test');
const { watchConsole } = require('./helpers');
const { mockPanel } = require('./mock-panel');

watchConsole();

for (const method of ['api', 'apiUpload', 'apiImage']) {
    test(`${method}: expired sessions and structured errors use the same contract`, async ({ page }) => {
        await mockPanel(page);
        const result = await page.evaluate(async (method) => {
            const client = await import('/js/api.js');
            const originalFetch = window.fetch;
            let ended = 0;
            const onEnd = () => ended++;
            window.addEventListener('session-ended', onEnd);
            const failures = [];
            try {
                for (const [status, body] of [
                    [401, { error: 'Sign in', fields: { session: 'expired' } }],
                    [422, { error: 'Bad value', fields: { value: 'invalid' } }],
                    [502, null]
                ]) {
                    window.fetch = (url, ...args) =>
                        String(url) === '/api/contract-test'
                            ? Promise.resolve(new Response(body ? JSON.stringify(body) : 'upstream failed', { status }))
                            : originalFetch(url, ...args);
                    try {
                        await client[method]('/contract-test', method === 'apiUpload' ? new FormData() : undefined);
                    } catch (err) {
                        failures.push({ message: err.message, status: err.status, data: err.data });
                    }
                }
            } finally {
                window.fetch = originalFetch;
                window.removeEventListener('session-ended', onEnd);
            }
            return { ended, failures };
        }, method);
        expect(result).toEqual({
            ended: 1,
            failures: [
                { message: 'Sign in', status: 401, data: { error: 'Sign in', fields: { session: 'expired' } } },
                { message: 'Bad value', status: 422, data: { error: 'Bad value', fields: { value: 'invalid' } } },
                { message: 'HTTP 502', status: 502, data: {} }
            ]
        });
    });
}

test('API success preserves JSON, multipart boundaries and image bytes', async ({ page }) => {
    await mockPanel(page);
    const result = await page.evaluate(async () => {
        const client = await import('/js/api.js');
        const originalFetch = window.fetch;
        const requests = [];
        window.fetch = (url, options) => {
            if (!String(url).startsWith('/api/contract-')) return originalFetch(url, options);
            requests.push({ url, headers: options.headers, multipart: options.body instanceof FormData });
            return Promise.resolve(new Response(String(url).endsWith('image') ? 'image bytes' : '{"ok":true}'));
        };
        try {
            const json = await client.api('/contract-json', { method: 'POST', body: { value: 1 } });
            const upload = await client.apiUpload('/contract-upload', new FormData());
            const image = await (await client.apiImage('/contract-image')).text();
            return { json, upload, image, requests };
        } finally {
            window.fetch = originalFetch;
        }
    });
    expect(result.json).toEqual({ ok: true });
    expect(result.upload).toEqual({ ok: true });
    expect(result.image).toBe('image bytes');
    expect(result.requests.every((r) => r.headers['X-Requested-By'] === 'notfckbot-panel')).toBe(true);
    expect(result.requests[1].multipart).toBe(true);
    expect(result.requests[1].headers['Content-Type']).toBeUndefined();
});
