/** The .env file: the panel writes tokens and the proxy there, and shows secrets only masked. */
const fs = require('fs');
const path = require('path');

/**
 * A value .env can hold safely: one line of printable ASCII. Anything with a line
 * break could smuggle a second KEY=value line in, and .env overrides the
 * container environment on every start.
 */
const isSafeEnvValue = (value) => typeof value === 'string' && /^[\x20-\x7e]*$/.test(value);

// Helper to update a value in the .env file
const updateEnvFile = (key, value) => {
    if (!isSafeEnvValue(value)) throw new Error(`Refusing to write an unsafe value to ${key}`);
    const envPath = path.join(__dirname, '../../.env');
    try {
        let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
        const regex = new RegExp(`^${key}=.*$`, 'm');
        if (regex.test(content)) {
            // A function replacement, so a "$" in a token is not read as a pattern
            content = content.replace(regex, () => `${key}=${value}`);
        } else {
            content += `\n${key}=${value}`;
        }
        fs.writeFileSync(envPath, content, 'utf-8');
    } catch (err) {
        console.error('[Admin] Failed to write .env:', err.message);
    }
};

/** "ad5dc619-…-73ff6d34659d" -> "ad5d*****659d". Short values are hidden entirely. */
function maskToken(token) {
    if (!token) return '';
    return token.length <= 12 ? '*****' : `${token.slice(0, 4)}*****${token.slice(-4)}`;
}

module.exports = { isSafeEnvValue, updateEnvFile, maskToken };
