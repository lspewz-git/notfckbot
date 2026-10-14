/** The .env file: the panel writes tokens and the proxy there, and shows secrets only masked. */
const fs = require('fs');
const path = require('path');

const ENV_PATH = process.env.ENV_FILE || path.join(__dirname, '../../.env');

/**
 * A value .env can hold safely: one line of printable ASCII. Anything with a line
 * break could smuggle a second KEY=value line in, and .env overrides the
 * container environment on every start.
 */
const isSafeEnvValue = (value) => typeof value === 'string' && /^[\x20-\x7e]*$/.test(value);

/**
 * Writes several keys at once, or none: every value is checked first, the previous file is kept
 * as .env.bak, and the new one replaces it in a single rename, so a crash mid-write can't leave
 * half a file. Other lines (keys not given, comments, blank lines) stay as they are. Throws on
 * an unsafe value or a failed write.
 * @param {Record<string, string>} changes KEY -> value
 */
function writeEnv(changes, envPath = ENV_PATH) {
    for (const [key, value] of Object.entries(changes)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Refusing to write the key "${key}"`);
        if (!isSafeEnvValue(value)) throw new Error(`Refusing to write an unsafe value to ${key}`);
    }
    const before = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    let content = before;
    for (const [key, value] of Object.entries(changes)) {
        const regex = new RegExp(`^${key}=.*$`, 'm');
        // A function replacement, so a "$" in a token is not read as a pattern
        if (regex.test(content)) content = content.replace(regex, () => `${key}=${value}`);
        else content += `${content && !content.endsWith('\n') ? '\n' : ''}${key}=${value}\n`;
    }
    if (content === before) return;
    // The new file and the backup get the old file's permissions: a fresh file would get the
    // default (readable by everyone on the host) and the secrets with it
    const mode = fs.existsSync(envPath) ? fs.statSync(envPath).mode & 0o777 : 0o600;
    if (before) writePrivate(`${envPath}.bak`, before, mode);
    const temp = `${envPath}.tmp`;
    writePrivate(temp, content, mode);
    try {
        fs.renameSync(temp, envPath);
    } catch (err) {
        // .env mounted into the container as a file of its own can't be replaced, only rewritten
        if (!['EBUSY', 'EXDEV', 'EPERM'].includes(err.code)) throw err;
        fs.writeFileSync(envPath, content, 'utf-8');
        fs.rmSync(temp, { force: true });
    }
}

/** Writes a file with `mode`, also when it exists already (writeFile sets the mode only on creation). */
function writePrivate(file, content, mode) {
    fs.writeFileSync(file, content, { encoding: 'utf-8', mode });
    fs.chmodSync(file, mode);
}

/** One key; a failed write is logged, not thrown (the value is already live in process.env). */
const updateEnvFile = (key, value) => {
    try {
        writeEnv({ [key]: value });
    } catch (err) {
        console.error('[Admin] Failed to write .env:', err.message);
    }
};

/** "ad5dc619-…-73ff6d34659d" -> "ad5d*****659d". Short values are hidden entirely. */
function maskToken(token) {
    if (!token) return '';
    return token.length <= 12 ? '*****' : `${token.slice(0, 4)}*****${token.slice(-4)}`;
}

module.exports = { isSafeEnvValue, writeEnv, updateEnvFile, maskToken };
