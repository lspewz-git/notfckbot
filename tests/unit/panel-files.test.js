/**
 * admin/index.html against the files it names: every panel module preloaded, nothing preloaded
 * that is gone. A module left out still works, only later (found when its importer has loaded).
 * Run: npm run test:unit
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ADMIN = path.join(__dirname, '../../admin');

test('every module in admin/js is preloaded, and every preloaded one exists', () => {
    const html = fs.readFileSync(path.join(ADMIN, 'index.html'), 'utf8');
    const preloaded = [...html.matchAll(/<link rel="modulepreload" href="js\/([^"]+)"/g)].map((m) => m[1]).sort();
    const modules = fs
        .readdirSync(path.join(ADMIN, 'js'))
        .filter((f) => f.endsWith('.js'))
        .sort();
    assert.deepEqual(preloaded, modules);
});
