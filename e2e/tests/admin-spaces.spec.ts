import { expect, test } from '@playwright/test';
import { signInAdmin } from './helpers';

test.use({ locale: 'en-US' });

// Group and team folder lifecycle in the admin UI. Not run in the first pass (R-par).
test('admin spaces: create a group and a team folder, assign, rename, remove', async ({ page }) => {
  test.setTimeout(120_000);
  const api = await signInAdmin(page);
  const sfx = Date.now().toString(36);
  const group = `E2E Marketing ${sfx}`;
  const team = `E2E Projekte ${sfx}`;
  const teamNew = `${team} neu`;
  const groupsTable = page.getByRole('table', { name: 'Groups' });
  const spacesTable = page.getByRole('table', { name: 'Spaces' });

  await test.step('create a group with a member', async () => {
    await page.goto('/admin/groups');
    await page.getByRole('button', { name: 'New group' }).click();
    const dialog = page.getByRole('dialog', { name: 'New group' });
    await dialog.getByLabel('Name').fill(`${group}`);
    await dialog.getByRole('checkbox').first().check();
    await dialog.getByRole('button', { name: 'Create group' }).click();
    await expect(page.getByText(`Group ${group} created`)).toBeVisible();
    await expect(groupsTable.getByRole('row').filter({ hasText: `${group}` })).toBeVisible();
  });

  await test.step('create a team folder and assign the group', async () => {
    await page.goto('/admin/spaces');
    await page.getByRole('button', { name: 'New team folder' }).click();
    const dialog = page.getByRole('dialog', { name: 'New team folder' });
    await dialog.getByLabel('Name').fill(`${team}`);
    await dialog.getByLabel('Add member').selectOption({ label: `${group}` });
    await dialog.getByLabel(`Access for ${group}`).selectOption('write');
    await dialog.getByRole('button', { name: 'Create team folder' }).click();
    await expect(page.getByText(`Team folder ${team} created`)).toBeVisible();
    const row = spacesTable.getByRole('row').filter({ hasText: `${team}` });
    await expect(row.getByText('Available')).toBeVisible();
    await expect(row.getByText('1 member')).toBeVisible();
  });

  await test.step('rename the team folder', async () => {
    const row = spacesTable.getByRole('row').filter({ hasText: `${team}` });
    await row.getByRole('button', { name: `Actions for ${team}` }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: `Edit ${team}` });
    await dialog.getByLabel('Name').fill(`${teamNew}`);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(spacesTable.getByRole('row').filter({ hasText: `${teamNew}` })).toBeVisible();
  });

  await test.step('remove the team folder; the folder stays on disk', async () => {
    const row = spacesTable.getByRole('row').filter({ hasText: `${teamNew}` });
    await row.getByRole('button', { name: `Actions for ${teamNew}` }).click();
    await page.getByRole('menuitem', { name: 'Remove' }).click();
    const confirm = page.getByRole('alertdialog', { name: `Remove ${teamNew}?` });
    await expect(confirm).toContainText('The folder stays on disk.');
    await confirm.getByRole('button', { name: 'Remove folder' }).click();
    await expect(spacesTable.getByRole('row').filter({ hasText: `${teamNew}` })).toHaveCount(0);
  });

  await test.step('delete the group', async () => {
    await page.goto('/admin/groups');
    await groupsTable.getByRole('button', { name: `Actions for ${group}` }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete group' }).click();
    await expect(groupsTable.getByRole('row').filter({ hasText: `${group}` })).toHaveCount(0);
  });
  await api.dispose();
});
