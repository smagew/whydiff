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
      // Same-platform renders are pixel-stable; this only absorbs sub-pixel AA noise.
      maxDiffPixelRatio: 0.002,
    },
  },
})
