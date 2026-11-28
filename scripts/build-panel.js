/** Prepare the browser files on the development machine; the server needs no build tool. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
async function buildPanel({ check = false } = {}) {
    const result = await esbuild.build({
        absWorkingDir: root,
        entryPoints: { app: 'admin/js/app.js', panel: 'admin/css/panel.css' },
        outdir: 'admin/dist/assets',
        entryNames: '[name]-[hash]',
        chunkNames: '[name]-[hash]',
        assetNames: '[name]-[hash]',
        bundle: true,
        splitting: true,
        format: 'esm',
        target: ['safari15', 'chrome100'],
        minify: true,
        loader: { '.woff2': 'file' },
        legalComments: 'eof',
        metafile: true,
        write: false
    });
    const outputs = new Map(
        result.outputFiles.map((file) => [path.relative(root, file.path).replaceAll('\\', '/'), file.contents])
    );
    const entry = (source) =>
        Object.keys(result.metafile.outputs).find((file) => result.metafile.outputs[file].entryPoint === source);
    const url = (file) => file.replace('admin/dist/', '');
    const app = entry('admin/js/app.js');
    const css = entry('admin/css/panel.css');
    const preloads = new Set();
    function walk(file) {
        for (const dependency of result.metafile.outputs[file].imports) {
            if (dependency.kind !== 'import-statement' || dependency.external || preloads.has(dependency.path))
                continue;
            preloads.add(dependency.path);
            walk(dependency.path);
        }
    }
    walk(app);
    const chart = await fs.readFile(path.join(root, 'admin/vendor/chart.umd.js'));
    const chartPath = `admin/dist/assets/chart-${createHash('sha256').update(chart).digest('hex').slice(0, 12)}.js`;
    outputs.set(chartPath, chart);
    const notices = await Promise.all(
        ['admin/fonts/onest.LICENSE', 'admin/fonts/jetbrains-mono.LICENSE', 'admin/vendor/i18next.LICENSE'].map(
            async (file) => `${file}\n\n${await fs.readFile(path.join(root, file), 'utf8')}`
        )
    );
    const license = Buffer.from(notices.join('\n\n'));
    outputs.set(
        `admin/dist/assets/licenses-${createHash('sha256').update(license).digest('hex').slice(0, 12)}.txt`,
        license
    );
    let html = await fs.readFile(path.join(root, 'admin/index.html'), 'utf8');
    html = html
        .replace('href="css/panel.css"', `href="${url(css)}"`)
        .replace('src="js/app.js"', `src="${url(app)}"`)
        .replace('data-src="vendor/chart.umd.js"', `data-src="${url(chartPath)}"`)
        .replace(
            '</head>',
            [...preloads].map((file) => `<link rel="modulepreload" href="${url(file)}" />`).join('\n') + '\n    </head>'
        );
    outputs.set('admin/dist/index.html', Buffer.from(html));
    for (const [file, content] of outputs) {
        const destination = path.join(root, file);
        if (check) {
            const existing = await fs.readFile(destination).catch(() => null);
            if (!existing || !Buffer.from(content).equals(existing))
                throw new Error(`Panel build is stale: ${file}. Run npm run build:panel.`);
        } else {
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, content);
        }
    }
    return { outputs, metafile: result.metafile };
}

if (require.main === module)
    buildPanel({ check: process.argv.includes('--check') }).catch((err) => {
        console.error(err.message);
        process.exitCode = 1;
    });
module.exports = { buildPanel };
