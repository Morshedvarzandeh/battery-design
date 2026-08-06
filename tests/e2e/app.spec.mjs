import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

function captureRuntimeErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.origin === 'http://127.0.0.1:4173'
      && response.status() >= 400
      && !url.pathname.startsWith('/api/')) {
      errors.push(`${response.status()} ${url.pathname}`);
    }
  });
  return errors;
}

async function blockingAxeViolations(page, state) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter(({ impact }) => impact === 'serious' || impact === 'critical')
    .map((violation) => ({ state, ...violation }));
}

function formatAxeViolations(violations) {
  return violations.map((violation) =>
    `[${violation.state}] ${violation.id}: ${violation.help}\n`
      + violation.nodes.map((node) => `  ${node.target.join(' ')}`).join('\n')
  ).join('\n');
}

test('the public designer loads, computes and navigates its core workflow', async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.setItem('bd-wizard-done', '1');
    localStorage.setItem('bd-audience', 'engineering');
  });

  await page.goto('/index.html');
  await expect(page).toHaveTitle(/battery sizing studio/i);
  await expect(page.locator('#selCell option')).toHaveCount(23);
  await expect(page.locator('#stageStats')).not.toBeEmpty();

  await page.locator('#inS').fill('14');
  await page.locator('#inS').blur();
  await expect(page.locator('#inS')).toHaveValue('14');

  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.locator('#pane-usage')).toBeVisible();
  await page.getByRole('tab', { name: 'Results' }).click();
  await expect(page.locator('#pane-results')).toBeVisible();
  expect(errors, `browser runtime errors:\n${errors.join('\n')}`).toEqual([]);
});

test('engineering tabs expose ARIA state and support arrow-key navigation', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('bd-wizard-done', '1');
    localStorage.setItem('bd-audience', 'engineering');
  });
  await page.goto('/index.html');

  await expect(page.getByRole('tablist', { name: 'Battery design workspace' })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(12);
  const designTab = page.getByRole('tab', { name: 'Design' });
  const usageTab = page.getByRole('tab', { name: 'Usage' });
  await expect(designTab).toHaveAttribute('aria-selected', 'true');
  await designTab.focus();
  await designTab.press('ArrowRight');
  await expect(usageTab).toBeFocused();
  await expect(usageTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Usage' })).toBeVisible();
});

test('Co-Simulation Studio prepares a connected engineering draft', async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto('/cosim.html');
  await expect(page).toHaveTitle(/Co-Simulation Studio/);

  await page.getByRole('button', { name: 'Voltage & temperature' }).click();
  await page.getByRole('button', { name: 'Prepare block draft' }).click();
  await page.getByRole('button', { name: 'Approve this draft' }).click();
  await expect(page.locator('#nodeLayer .sim-node')).toHaveCount(8);
  await expect(page.locator('#graphIdentity')).toContainText('8 blocks');
  expect(errors, `browser runtime errors:\n${errors.join('\n')}`).toEqual([]);
});

test('every main workspace state and the sizing wizard have no serious or critical WCAG violations', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    localStorage.setItem('bd-wizard-done', '1');
    localStorage.setItem('bd-audience', 'engineering');
  });
  await page.goto('/index.html');
  const blocking = [];
  const tabs = page.getByRole('tab');
  for (let index = 0; index < await tabs.count(); index++) {
    const tab = tabs.nth(index);
    const state = (await tab.innerText()).replace(/\s+/g, ' ').trim();
    await tab.click();
    const panelId = await tab.getAttribute('aria-controls');
    await expect(page.locator(`#${panelId}`)).toBeVisible();
    blocking.push(...await blockingAxeViolations(page, `tab: ${state}`));
  }

  await page.locator('#btnWizard').click();
  await expect(page.locator('#wizard')).toBeVisible();
  blocking.push(...await blockingAxeViolations(page, 'sizing wizard'));
  expect(blocking, formatAxeViolations(blocking)).toEqual([]);
});

test('Co-Simulation Studio draft states have no serious or critical WCAG violations', async ({ page }) => {
  await page.goto('/cosim.html');
  const blocking = await blockingAxeViolations(page, 'empty studio');
  await page.getByRole('button', { name: 'Voltage & temperature' }).click();
  await page.getByRole('button', { name: 'Prepare block draft' }).click();
  await page.getByRole('button', { name: 'Approve this draft' }).click();
  await expect(page.locator('#nodeLayer .sim-node')).toHaveCount(8);
  blocking.push(...await blockingAxeViolations(page, 'approved connected draft'));
  expect(blocking, formatAxeViolations(blocking)).toEqual([]);
});
