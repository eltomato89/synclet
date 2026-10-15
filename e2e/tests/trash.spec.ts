import { expect, test } from '@playwright/test';
import { mkdir, newUser, row, signIn, upload } from './helpers';

test.use({ locale: 'en-US' });

test('delete a folder, find it in the trash, restore it into its old place', async ({ page }) => {
  const user = await newUser('trash');
  const folderId = await mkdir(user.api, 'root', 'Projects');
  const fileId = await upload(user.api, folderId, 'plan.txt', 'step one');
  await signIn(page, user);

  await row(page, 'Projects').click();
  await page.keyboard.press('Delete');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Move to trash' }).click();
  await expect(row(page, 'Projects')).toBeHidden();

  await page.getByRole('navigation').getByRole('link', { name: 'Trash' }).click();
  await expect(page).toHaveURL(/\/trash$/);
  const trash = page.getByRole('table', { name: 'Trash' });
  await expect(trash.getByRole('row').filter({ hasText: 'Projects' })).toBeVisible();
  await trash.getByRole('button', { name: 'Restore Projects' }).click();
  await expect(page.getByText('“Projects” restored')).toBeVisible();
  await expect(trash.getByRole('row').filter({ hasText: 'Projects' })).toBeHidden();

  await page.getByRole('navigation').getByRole('link', { name: 'My files' }).click();
  await row(page, 'Projects').dblclick();
  await expect(page).toHaveURL(new RegExp(`/files/${folderId}$`)); // same folder ID as before
  await expect(row(page, 'plan.txt')).toBeVisible();

  // The restored subtree keeps its IDs.
  const children = await (await user.api.get(`/api/sync/v1/items/${folderId}/children`)).json();
  expect(children.items.map((i: { id: string; name: string }) => [i.id, i.name])).toEqual([[fileId, 'plan.txt']]);
});
