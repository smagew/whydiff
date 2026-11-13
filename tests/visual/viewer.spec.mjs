// Screenshots of the reference example (examples/rate-limit) in every viewer tab.
// Update baselines ONLY deliberately: `make screenshots-update` (both platforms).
import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// Built once per worker: the same prep as tests/smoke.mjs (embedFull needs the
// original repo on disk, so it is stripped; fragments still render).
let url
test.beforeAll(() => {
  const rm = JSON.parse(readFileSync(join(root, 'examples', 'rate-limit', 'review-map.json'), 'utf8'))
  for (const f of Object.values(rm.files)) delete f.embedFull
  const work = mkdtempSync(join(tmpdir(), 'whydiff-visual-'))
  writeFileSync(join(work, 'review-map.json'), JSON.stringify(rm))
  execFileSync(process.execPath, [join(root, 'scripts', 'assemble.mjs'), join(work, 'review-map.json'), '--out', join(work, 'map.html')], { stdio: 'ignore' })
  url = pathToFileURL(join(work, 'map.html')).href
})

// The -linux baselines are only valid in the image they were recorded in. If
// @playwright/test is bumped without the CI image (or vice versa), Chromium differs and
// every screenshot fails for no visual reason — say so plainly instead.
test('CI image matches @playwright/test', () => {
  const pw = JSON.parse(readFileSync(join(root, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version
  const ci = readFileSync(join(root, '.github', 'workflows', 'validate.yml'), 'utf8').match(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/)?.[1]
  expect(ci, 'validate.yml must run in mcr.microsoft.com/playwright:v<version>-noble').toBe(pw)
})

const TAB_COUNT = 7  // Diagrams · Files · User stories · Summary · Ops & risks · Standards · Tests
const PALETTES = { dark: 'graphite', light: 'slate' }
const WINDOWS = { wide: { width: 1440, height: 900 }, narrow: { width: 900, height: 1000 } }

for (const [winName, viewport] of Object.entries(WINDOWS)) {
  for (const [themeName, palette] of Object.entries(PALETTES)) {
    test(`${winName} ${themeName}`, async ({ page }) => {
      await page.setViewportSize(viewport)
      await page.goto(url)
      // Switch the way the UI does (applyPalette re-renders the diagrams' baked theme).
      await page.locator(`.themepick button[data-v="${palette}"]`).click()
      const panes = await page.locator('#tabs .tab').evaluateAll((ts) => ts.map((t) => t.dataset.pane))
      expect(panes.length, 'tab set changed — update TABS deliberately').toBe(TAB_COUNT)
      for (const pane of panes) {
        await page.locator(`#tabs .tab[data-pane="${pane}"]`).click()
        if (pane === 'diagrams') await expect(page.locator('#pane-diagrams pre.mermaid > svg').first()).toBeVisible()
        await page.evaluate(() => document.fonts.ready)
        await page.mouse.move(0, 0)
        await expect.soft(page).toHaveScreenshot(`${pane}-${themeName}-${winName}.png`, { fullPage: true })
      }
    })
  }
}
