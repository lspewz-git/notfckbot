/**
 * The Terms of Service and the Privacy Policy a person must accept before using the panel: on the
 * sign-in screen (its checkbox) or, when there was no checkbox (the Mini App, a sign-in link, an older
 * session, a new version of either document), on "Before you start". Each acceptance is a row in
 * TermsAcceptance; the guard refuses the panel (428) until the current versions are accepted.
 * A new version: change the date here and the EDITION in admin/js/legal.js (a unit test keeps them equal).
 */
const { TermsAcceptance } = require('../db');
const { lruCache } = require('../lru');
const { ipOf } = require('./devices');

const TERMS_VERSION = '2026-11-18';
const PRIVACY_VERSION = '2026-11-18';
const SOURCES = ['signin', 'before-you-start'];

// People who accepted the current versions: the guard asks on every request
const accepted = lruCache({ max: 5000, ttl: 10 * 60 * 1000 });

/**
 * 'ok' (current versions accepted, or the system account: the operator's own login), 'first' (never
 * accepted) or 'updated' (accepted an older version).
 * @param {{ userId: string, system?: boolean }} user
 * @returns {Promise<'ok' | 'first' | 'updated'>}
 */
async function termsState(user) {
    if (user.system || accepted.has(user.userId)) return 'ok';
    const rows = await TermsAcceptance.findAll({
        where: { userId: user.userId },
        attributes: ['termsVersion', 'privacyVersion'],
        raw: true
    });
    if (rows.some((r) => r.termsVersion === TERMS_VERSION && r.privacyVersion === PRIVACY_VERSION)) {
        accepted.set(user.userId, true);
        return 'ok';
    }
    return rows.length ? 'updated' : 'first';
}

/** Records that the signed-in person accepted the current versions. */
async function acceptTerms(req, source) {
    const ip = ipOf(req);
    await TermsAcceptance.create({
        userId: req.user.userId,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        source,
        ip: ip ? ip.slice(0, 45) : null,
        userAgent: String(req.get('user-agent') || '').slice(0, 512) || null
    });
    accepted.set(req.user.userId, true);
}

/** Tests: no one remembered as having accepted. */
const forgetTerms = () => accepted.clear();

module.exports = { TERMS_VERSION, PRIVACY_VERSION, SOURCES, termsState, acceptTerms, forgetTerms };
