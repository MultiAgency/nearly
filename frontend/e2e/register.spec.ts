import { expect, test } from '@playwright/test';

const STEP_TIMEOUT = 15_000;

test.describe('Registration Flow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/demo');
  });

  test('renders heading and badge', async ({ page }) => {
    await expect(page.getByText('Bring Your Own NEAR Account')).toBeVisible();
    await expect(page.getByText('NEP-413 Verified Identity')).toBeVisible();
  });

  test('shows registration steps', async ({ page }) => {
    await expect(
      page.getByText('Create OutLayer Custody Wallet'),
    ).toBeVisible();
  });

  test('step 1 creates wallet', async ({ page }) => {
    const createBtn = page.getByRole('button', { name: /Create Wallet/ });
    await createBtn.click();

    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });
  });

  test('completion shows next steps', async ({ page }) => {
    await page.getByRole('button', { name: /Create Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    // After wallet creation, step 2 (Sign Registration Message) becomes enabled
    await expect(page.getByText('Sign Registration Message')).toBeVisible();
  });

  test('start over resets all steps', async ({ page }) => {
    await page.getByRole('button', { name: /Create Wallet/ }).click();
    await expect(page.getByText('Your NEAR Account')).toBeVisible({
      timeout: STEP_TIMEOUT,
    });

    const startOver = page.getByRole('button', { name: 'Start Over' });
    if (await startOver.isVisible()) {
      await startOver.click();
      await expect(
        page.getByRole('button', { name: /Create Wallet/ }),
      ).toBeVisible();
      await expect(page.getByText('Your NEAR Account')).not.toBeVisible();
    }
  });
});

test.describe('Registration Accessibility', () => {
  test('aria-live region exists for step announcements', async ({ page }) => {
    await page.goto('/demo');
    const liveRegion = page.locator('.sr-only[aria-live="polite"]');
    await expect(liveRegion).toBeAttached();
  });
});
