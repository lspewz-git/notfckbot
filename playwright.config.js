const { defineConfig, devices } = require('@playwright/test');

/**
 * The suite runs against a running panel — it does not start one. Point it at
 * whatever instance you want to check:
 *
 *   ADMIN_URL=http://localhost:8088 npm test
 *
 * Every test is read-only: dialogs are opened and dismissed, nothing is
 * created, edited or deleted, so it is safe against a live instance.
 */
module.exports = defineConfig({
    testDir: './tests',
    // Overridable because some mounts refuse mkdir at the project root
    outputDir: process.env.PW_OUTPUT || 'test-results',
    fullyParallel: false,
    workers: 1,
    reporter: process.env.CI ? 'line' : 'list',
    use: {
        baseURL: process.env.ADMIN_URL || 'http://localhost:8088',
        trace: 'retain-on-failure'
    },
    projects: [
        { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } },
        { name: 'mobile', use: { ...devices['iPhone 12 Mini'] } }
    ]
});
