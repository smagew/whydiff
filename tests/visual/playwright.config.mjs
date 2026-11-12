// Visual regression for the viewer: every tab × dark/light palette × wide/narrow
// window, compared against committed baselines. Catches what behaviour tests miss —
// "it rendered, but crooked". Baselines are per platform (fonts differ): -darwin
// from a Mac, -linux from the official Playwright image (= CI). See README.md here.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: /\.spec\.mjs$/,
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}-{platform}{ext}',
  reporter: [['list']],
  fullyParallel: true,
  use: { browserName: 'chromium', deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'en-US', timezoneId: 'UTC' },
  expect: {
    // A cold CI container renders mermaid slower; toHaveScreenshot retries until stable.
    timeout: 15000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      stylePath: new URL('./capture.css', import.meta.url).pathname,
      scale: 'css',
      // Same-platform renders are byte-identical run to run (re-recording all 56
      // baselines changed only the ones a change touched). A ratio was too loose: 0.2%
      // of a full page is ~3,900px, and a real change (muting the directory of every
      // path in the Files navigator, ~2,700px) passed under it. An absolute budget
      // keeps a margin for a stray anti-aliased pixel and catches a one-word change.
      maxDiffPixels: 100,
    },
  },
})
