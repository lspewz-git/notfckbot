/**
 * Flat ESLint config.
 *
 * Deliberately self-contained: no `@eslint/js` or `globals` imports, so it
 * works with nothing but `eslint` installed and cannot fail on module
 * resolution. The rule list below is the useful half of eslint:recommended
 * plus a few project rules.
 *
 * Two environments live here — the bot and admin API are CommonJS on Node,
 * the admin panel is ES modules in the browser — so each gets its own globals
 * and `no-undef` catches a stray `require` in the frontend or a `document`
 * reference in the backend.
 */

const NODE_GLOBALS = {
    require: 'readonly',
    module: 'writable',
    exports: 'writable',
    process: 'readonly',
    console: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    Buffer: 'readonly',
    setTimeout: 'readonly',
    setInterval: 'readonly',
    clearTimeout: 'readonly',
    clearInterval: 'readonly',
    URL: 'readonly'
};

const BROWSER_GLOBALS = {
    window: 'readonly',
    document: 'readonly',
    console: 'readonly',
    fetch: 'readonly',
    localStorage: 'readonly',
    location: 'readonly',
    navigator: 'readonly',
    performance: 'readonly',
    setTimeout: 'readonly',
    setInterval: 'readonly',
    clearTimeout: 'readonly',
    clearInterval: 'readonly',
    Event: 'readonly',
    URL: 'readonly',
    getComputedStyle: 'readonly'
};

const RULES = {
    // Correctness
    'no-undef': 'error',
    'no-dupe-keys': 'error',
    'no-dupe-args': 'error',
    'no-duplicate-case': 'error',
    'no-unreachable': 'error',
    'no-fallthrough': 'error',
    'no-func-assign': 'error',
    'no-obj-calls': 'error',
    'no-redeclare': 'error',
    'no-self-assign': 'error',
    'no-sparse-arrays': 'error',
    'no-unsafe-negation': 'error',
    'no-const-assign': 'error',
    'no-global-assign': 'error',
    'no-cond-assign': 'error',
    'no-constant-condition': ['error', { checkLoops: false }],
    'use-isnan': 'error',
    'valid-typeof': 'error',

    // Style choices this codebase already follows
    eqeqeq: ['error', 'smart'],
    'no-var': 'error',
    'prefer-const': 'error',
    'no-implicit-globals': 'error',
    'no-empty': ['error', { allowEmptyCatch: true }],

    // An unused argument is usually fine; an unused import or variable is not
    'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
};

export default [
    { ignores: ['node_modules/**'] },

    {
        // Bot, API, cron, one-off maintenance scripts
        files: ['src/**/*.js', '*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: NODE_GLOBALS
        },
        rules: RULES
    },

    {
        // Admin panel
        files: ['admin/js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: BROWSER_GLOBALS
        },
        rules: RULES
    }
];
