/**
 * The drawing itself, in a thread of its own (src/recap/pool.js): satori lays a card out into
 * SVG, resvg draws the SVG. A card takes a CPU core for a second or more; here the bot's own thread
 * keeps answering meanwhile. resvg's WebAssembly build, not the native one: the native one kept
 * about 40 MB more after every six cards (measured 23.10). The thread ends when idle, and its
 * memory with it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const resvg = require('@resvg/resvg-wasm');
const { WIDTH, HEIGHT } = require('./size');

// On Linux the nice value is a thread's own: this thread yields the core to the bot's, which
// keeps its priority. Elsewhere (Windows, macOS) it would be the whole process's: left alone
if (process.platform === 'linux') {
    try {
        os.setPriority(19);
    } catch {
        // Not allowed in this container: drawn at the bot's priority
    }
}

// satori is an ES module with a CommonJS build
const satori = require('satori').default;
const wasmReady = resvg.initWasm(fs.readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));

const FONT_DIR = path.join(path.dirname(require.resolve('@fontsource/manrope/package.json')), '..');
// Each family comes as Latin and Cyrillic files; satori takes the first font of a name, so the
// Cyrillic half goes under a name of its own and the cards ask for "Manrope, Manrope Cyr"
const FONT_FILES = [
    ['Unbounded', 'unbounded', 700],
    ['Unbounded', 'unbounded', 900],
    ['Manrope', 'manrope', 600],
    ['Manrope', 'manrope', 700],
    ['Manrope', 'manrope', 800]
];
const fonts = FONT_FILES.flatMap(([name, dir, weight]) =>
    ['latin', 'cyrillic'].map((subset) => ({
        name: subset === 'latin' ? name : `${name} Cyr`,
        data: fs.readFileSync(path.join(FONT_DIR, dir, 'files', `${dir}-${subset}-${weight}-normal.woff`)),
        weight,
        style: 'normal'
    }))
);

/**
 * An SVG drawn to PNG, with its raw pixels when asked; freed by hand (WebAssembly memory isn't
 * the garbage collector's).
 */
function draw(svg, { fitTo, pixels = false } = {}) {
    const drawing = new resvg.Resvg(svg, { font: { loadSystemFonts: false }, ...(fitTo ? { fitTo } : {}) });
    const image = drawing.render();
    try {
        return { png: Buffer.from(image.asPng()), pixels: pixels ? image.pixels : null };
    } finally {
        image.free();
        drawing.free();
    }
}

/** An SVG of one picture filling width x height, cropped to fit, like CSS's object-fit: cover. */
const pictureSvg = (uri, width, height) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<image href="${uri}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/></svg>`;

/**
 * The JPEG's EXIF Orientation (1 to 8), 1 when it has none. A phone stores a portrait photo as it
 * lay on the sensor and says "turn me" here; resvg doesn't read it (checked 24.10), so the picture
 * is turned before it is drawn. One tag: a library for all of EXIF would be more than the job.
 */
function orientationOf(bytes) {
    let at = 2;
    while (at + 4 < bytes.length && bytes[at] === 0xff) {
        const marker = bytes[at + 1];
        const length = bytes.readUInt16BE(at + 2);
        // Exif comes in APP1, before the picture data starts (SOS)
        if (marker === 0xda) break;
        if (marker === 0xe1 && bytes.toString('binary', at + 4, at + 10) === 'Exif\0\0') {
            const tiff = at + 10;
            if (tiff + 8 > bytes.length) return 1;
            const little = bytes.toString('binary', tiff, tiff + 2) === 'II';
            const u16 = (o) => (little ? bytes.readUInt16LE(o) : bytes.readUInt16BE(o));
            const u32 = (o) => (little ? bytes.readUInt32LE(o) : bytes.readUInt32BE(o));
            const ifd = tiff + u32(tiff + 4);
            if (ifd + 2 > bytes.length) return 1;
            const count = u16(ifd);
            for (let i = 0; i < count; i += 1) {
                const entry = ifd + 2 + i * 12;
                if (entry + 12 > bytes.length) return 1;
                if (u16(entry) === 0x0112) {
                    const value = u16(entry + 8);
                    return value >= 1 && value <= 8 ? value : 1;
                }
            }
            return 1;
        }
        at += 2 + length;
    }
    return 1;
}

// How each EXIF orientation maps the picture as stored (w x h, at 0,0) onto it the right way up;
// 5 to 8 swap width and height
const TURNS = {
    1: () => '',
    2: (w) => `matrix(-1 0 0 1 ${w} 0)`,
    3: (w, h) => `matrix(-1 0 0 -1 ${w} ${h})`,
    4: (w, h) => `matrix(1 0 0 -1 0 ${h})`,
    5: () => 'matrix(0 1 1 0 0 0)',
    6: (w, h) => `matrix(0 1 -1 0 ${h} 0)`,
    7: (w, h) => `matrix(0 -1 -1 0 ${h} ${w})`,
    8: (w) => `matrix(0 -1 1 0 0 ${w})`
};

/**
 * An upload filling a card, cropped to fit like CSS's object-fit: cover, turned the right way up:
 * the picture as stored sits turned inside a frame of its upright size, which is then fitted.
 */
function uprightSvg(uri, size, orientation) {
    const { width: w, height: h } = size;
    const [W, H] = orientation >= 5 ? [h, w] : [w, h];
    const turn = TURNS[orientation](w, h);
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">` +
        `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">` +
        `<image href="${uri}" width="${w}" height="${h}"${turn ? ` transform="${turn}"` : ''}/></svg></svg>`
    );
}

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const starts = (bytes, sig) => sig.every((b, i) => bytes[i] === b);
// 5 MB limits the file, not the picture: a small PNG of 15000x15000 would unpack to about 900 MB
// in the drawing's memory, which is the bot's process. A phone's 24 MP photo still fits
const MAX_PIXELS = 25e6;

/** A PNG's or JPEG's width and height from its header, without unpacking it; null if not found. */
function pictureSize(bytes, type) {
    if (type === 'image/png') {
        return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
    }
    // JPEG: walk the segments to the frame header (SOF0 to SOF15, not DHT C4, JPG C8, DAC CC)
    let at = 2;
    while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) return null;
        const marker = bytes[at + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
        }
        at += 2 + bytes.readUInt16BE(at + 2);
    }
    return null;
}

/**
 * The tasks:
 * - { kind: 'card', element }: a card's PNG, 1080x1350;
 * - { kind: 'thumb', png }: a small copy of a card for the panel's lists;
 * - { kind: 'fit', bytes }: an uploaded PNG or JPEG cropped to a card's 1080x1350, as PNG; throws
 *   for anything else, or a file that draws nothing.
 */
module.exports = async function run(task) {
    await wasmReady;
    if (task.kind === 'card') {
        const svg = await satori(task.element, { width: WIDTH, height: HEIGHT, fonts });
        // Text is already shapes in satori's SVG: resvg needs no fonts of its own
        return draw(svg).png;
    }
    if (task.kind === 'thumb') {
        const uri = `data:image/png;base64,${Buffer.from(task.png).toString('base64')}`;
        return draw(pictureSvg(uri, WIDTH, HEIGHT), { fitTo: { mode: 'width', value: task.width || 120 } }).png;
    }
    if (task.kind === 'fit') {
        const bytes = Buffer.from(task.bytes);
        const type = starts(bytes, PNG) ? 'image/png' : starts(bytes, JPEG) ? 'image/jpeg' : null;
        if (!type) throw new Error('Not a PNG or JPEG picture');
        const size = pictureSize(bytes, type);
        if (!size || !size.width || !size.height) throw new Error('This picture could not be read');
        if (size.width * size.height > MAX_PIXELS) {
            throw new Error(`Too big: ${size.width} × ${size.height}. Up to 25 megapixels, please`);
        }
        const orientation = type === 'image/jpeg' ? orientationOf(bytes) : 1;
        const uri = `data:${type};base64,${bytes.toString('base64')}`;
        const { png, pixels } = draw(uprightSvg(uri, size, orientation), { pixels: true });
        // A file that only looks like a picture draws nothing: every pixel transparent
        let seen = false;
        for (let i = 3; i < pixels.length && !seen; i += 4 * 97) seen = pixels[i] !== 0;
        if (!seen) throw new Error('This picture could not be read');
        return png;
    }
    throw new Error(`Unknown task: ${task.kind}`);
};

// For the tests: reading the turn and placing the picture
module.exports.orientationOf = orientationOf;
module.exports.uprightSvg = uprightSvg;
