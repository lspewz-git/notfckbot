/**
 * Which commit is checked out where the bot runs, for the dashboard. Read straight from .git
 * (the image has no git; in Docker the project folder, .git included, is a bind mount), so a
 * `git pull` on the server shows up without a rebuild. Anything missing gives null fields,
 * never an error: a copy without .git simply has no version to show.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GIT_DIR = path.join(__dirname, '..', '..', '.git');
const SHA = /^[0-9a-f]{40}$/;

function readGit(rel) {
    try {
        return fs.readFileSync(path.join(GIT_DIR, rel), 'utf8').trim();
    } catch {
        return null;
    }
}

/** The full hash HEAD points at: a detached hash, a loose ref, or a line of packed-refs. */
function headCommit() {
    const head = readGit('HEAD');
    if (!head) return null;
    if (!head.startsWith('ref: ')) return SHA.test(head) ? head : null;
    const ref = head.slice('ref: '.length);
    const loose = readGit(ref);
    if (loose && SHA.test(loose)) return loose;
    const line = (readGit('packed-refs') || '').split('\n').find((l) => l.endsWith(` ${ref}`));
    return line && SHA.test(line.slice(0, 40)) ? line.slice(0, 40) : null;
}

/**
 * Subject and commit time, from the loose object. A commit fetched by `git pull` is usually
 * loose; one inside a pack is not read (that needs a pack parser), and the fields stay null.
 */
function commitDetails(sha) {
    try {
        const raw = zlib.inflateSync(fs.readFileSync(path.join(GIT_DIR, 'objects', sha.slice(0, 2), sha.slice(2))));
        const text = raw.toString('utf8');
        const body = text.slice(text.indexOf('\0') + 1);
        const [headers, ...message] = body.split('\n\n');
        const committer = headers.split('\n').find((l) => l.startsWith('committer '));
        const seconds = committer && Number(committer.split(' ').at(-2));
        return {
            subject: (message.join('\n\n').split('\n')[0] || '').trim() || null,
            date: Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null
        };
    } catch {
        return { subject: null, date: null };
    }
}

/** https://github.com/owner/repo for an https or ssh GitHub remote; null for anything else. */
function githubUrl() {
    const config = readGit('config') || '';
    const section = config.split(/^\[/m).find((s) => s.startsWith('remote "origin"]'));
    const url = section && (section.match(/^\s*url\s*=\s*(.+)$/m) || [])[1];
    const m = url && url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    return m ? `https://github.com/${m[1]}` : null;
}

/** { commit, short, subject, date, url } — all null when there is no .git to read. */
function getVersion() {
    const commit = headCommit();
    if (!commit) return { commit: null, short: null, subject: null, date: null, url: null };
    const repo = githubUrl();
    return {
        commit,
        short: commit.slice(0, 7),
        ...commitDetails(commit),
        url: repo ? `${repo}/commit/${commit}` : null
    };
}

module.exports = { getVersion };
