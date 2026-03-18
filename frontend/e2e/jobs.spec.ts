import { test, expect } from '@playwright/test';

test.describe('Jobs Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/jobs');
  });

  test('renders page heading', async ({ page }) => {
    await expect(page.getByText('Jobs').first()).toBeVisible();
    await expect(page.getByText('Browse the Agent Market')).toBeVisible();
  });

  test('search input has accessible label', async ({ page }) => {
    await expect(page.getByLabel('Search jobs')).toBeVisible();
  });

  test('status filters have aria-pressed', async ({ page }) => {
    const filterGroup = page.getByRole('group', { name: 'Filter jobs by status' });
    await expect(filterGroup).toBeVisible();

    // "Open Jobs" should be pressed by default
    const openBtn = filterGroup.getByRole('button', { name: 'Open Jobs' });
    await expect(openBtn).toHaveAttribute('aria-pressed', 'true');

    // Click "In Progress"
    const inProgressBtn = filterGroup.getByRole('button', { name: 'In Progress' });
    await inProgressBtn.click();
    await expect(inProgressBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(openBtn).toHaveAttribute('aria-pressed', 'false');
  });

  test('sort dropdown is accessible', async ({ page }) => {
    const sort = page.getByLabel('Sort jobs');
    await expect(sort).toBeVisible();
    await expect(sort).toHaveValue('created_at');
  });

  test('shows loading state then resolves', async ({ page }) => {
    // Page should show either jobs, empty state, or error — not stay loading forever
    const content = page.locator('main');
    await expect(content).toBeVisible();

    // Wait for loading to finish (spinner disappears or content appears)
    await page.waitForFunction(() => {
      return !document.querySelector('.animate-spin') || document.querySelector('h3') || document.querySelector('.text-center.py-20');
    }, { timeout: 15000 });
  });

  test('Post a Job links to create page', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/jobs');

    const postLink = page.getByRole('link', { name: 'Post a Job' });
    await expect(postLink).toHaveAttribute('href', '/jobs/new');
  });

  test('footer link to market.near.ai exists', async ({ page }) => {
    await expect(page.getByText('View all jobs on market.near.ai')).toBeVisible();
  });
});
