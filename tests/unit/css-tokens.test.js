/**
 * Colours live in admin/css/base.css as tokens; every other stylesheet uses the variables, so a
 * palette change is one file (admin/DESIGN.md). Inline styles in index.html are left out.
 * Run: npm run test:unit
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS = path.join(__dirname, '../../admin/css');

test('no raw colour outside base.css', () => {
    const found = [];
    for (const file of fs.readdirSync(CSS).filter((f) => f.endsWith('.css') && f !== 'base.css')) {
        const lines = fs.readFileSync(path.join(CSS, file), 'utf8').split('\n');
        lines.forEach((line, i) => {
            // A value, not a selector: "#add-content-modal {" is an id
            const value = line.includes(':') && !line.trim().endsWith('{') ? line : '';
            // A colour built from a variable is generated, not picked: the avatars' per-chat hue
            const raw = value.replace(/\b(rgba?|hsla?)\(var\([^)]*\)[^)]*\)/gi, '');
            if (/#[0-9a-f]{3,8}\b|\b(rgba?|hsla?)\(/i.test(raw)) found.push(`${file}:${i + 1}: ${line.trim()}`);
        });
    }
    assert.deepEqual(found, []);
});
