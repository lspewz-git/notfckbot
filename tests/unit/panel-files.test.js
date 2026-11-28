/** Built entries preload their static graph, never the deferred administrative screens. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ADMIN = path.join(__dirname, '../../admin');

test('current build preloads the complete static entry graph and keeps admin and Chart.js deferred', async () => {
    const { metafile } = await require('../../scripts/build-panel').buildPanel({ check: true });
    const html = fs.readFileSync(path.join(ADMIN, 'dist/index.html'), 'utf8');
    const preloaded = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]);
    const app = Object.keys(metafile.outputs).find((file) => metafile.outputs[file].entryPoint === 'admin/js/app.js');
    const expected = new Set();
    function walk(file) {
        for (const dependency of metafile.outputs[file].imports) {
            if (dependency.kind !== 'import-statement' || dependency.external || expected.has(dependency.path))
                continue;
            expected.add(dependency.path);
            walk(dependency.path);
        }
    }
    walk(app);
    assert.deepEqual(preloaded.sort(), [...expected].map((file) => file.replace('admin/dist/', '')).sort());
    const admin = Object.keys(metafile.outputs).find(
        (file) => metafile.outputs[file].entryPoint === 'admin/js/admin.js'
    );
    assert.ok(admin, 'administrative screens have a separate lazy entry');
    assert.ok(!expected.has(admin));
    assert.doesNotMatch(html, /<script[^>]+src="[^\"]*chart/);
    assert.doesNotMatch(html, /fonts\.google|lru-cache/);
    for (const match of html.matchAll(/(?:href|src|data-src)="(assets\/[^\"]+)"/g))
        assert.ok(fs.existsSync(path.join(ADMIN, 'dist', match[1])), match[1]);
});
