/** Read the first matching cookie without decoding it; callers validate their own token format. */
function cookieValue(header, cookieName) {
    for (const part of String(header || '').split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === cookieName) return rest.join('=');
    }
    return null;
}

module.exports = { cookieValue };
