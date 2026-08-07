import { expect, test } from '@playwright/test';

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

test('cosim page loads without runtime errors', async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.goto('/cosim.html');
  await expect(page).toHaveTitle(/Co-Simulation Studio/);
  await expect(page.locator('#goalInput')).toBeVisible();
  await expect(page.locator('#graphCanvas')).toBeVisible();
  await expect(page.locator('#marketSelect')).toBeVisible();
  expect(errors, `browser runtime errors:\n${errors.join('\n')}`).toEqual([]);
});

test('clicking example button fills the goal textarea', async ({ page }) => {
  await page.goto('/cosim.html');
  await page.getByRole('button', { name: 'Voltage & temperature' }).click();
  await expect(page.locator('#goalInput')).toHaveValue('Show cell voltage and temperature during a current step.');
});

test('selecting grid market reveals segment field', async ({ page }) => {
  await page.goto('/cosim.html');
  await expect(page.locator('#segmentField')).toBeHidden();
  await page.locator('#marketSelect').selectOption('grid');
  await expect(page.locator('#segmentField')).toBeVisible();
});
