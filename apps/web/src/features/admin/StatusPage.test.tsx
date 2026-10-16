import type { VersionInfoWire } from '@synclet/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import { VersionReading } from './StatusPage';

beforeAll(async () => { await i18n.changeLanguage('en'); });
afterEach(() => { cleanup(); });

const base: VersionInfoWire = {
  installed: '0.1.2', revision: 'abcdef0123456', latest: null, latestUrl: null, checkedAt: '2026-10-16T10:00:00.000Z', status: 'up-to-date',
};
function show(v: Partial<VersionInfoWire>) {
  render(<dl><VersionReading version={{ ...base, ...v }} uptimeSec={300} /></dl>);
  return screen.getByText('Version').parentElement!;
}

it('shows the installed release as up to date', () => {
  const row = show({ latest: '0.1.2', latestUrl: 'https://github.com/eltomato89/synclet/releases/tag/v0.1.2' });
  expect(row).toHaveTextContent('0.1.2');
  expect(row).toHaveTextContent('Up to date');
  expect(row).toHaveTextContent('Running for 5 min');
  expect(screen.queryByRole('link')).toBeNull();
});

it('links the release notes of an available update in a new tab', () => {
  const url = 'https://github.com/eltomato89/synclet/releases/tag/v0.1.3';
  const row = show({ latest: '0.1.3', latestUrl: url, status: 'update-available' });
  expect(row).toHaveTextContent('0.1.2');
  const link = screen.getByRole('link', { name: /^Update available: 0\.1\.3/ });
  expect(link).toHaveAttribute('href', url);
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(link).toHaveAccessibleName('Update available: 0.1.3 (opens in a new tab)');
});

it('shows no link for release notes outside github.com', () => {
  show({ latest: '0.1.3', latestUrl: 'https://evil.example/notes', status: 'update-available' });
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('Version').parentElement!).toHaveTextContent('Update available: 0.1.3');
});

it('shows a development build with its tag and short commit', () => {
  const row = show({ installed: 'edge', status: 'development', checkedAt: null });
  expect(row).toHaveTextContent('Development build');
  expect(row).toHaveTextContent('edge · abcdef0');
  expect(row).not.toHaveTextContent('abcdef01');
});

it('shows a development build without a known commit', () => {
  const row = show({ installed: 'dev', revision: null, status: 'development', checkedAt: null });
  expect(row).toHaveTextContent('Development build');
  expect(row).toHaveTextContent(/dev(?! ·)/);
});

it.each([
  ['checking', 'Checking for updates…'],
  ['unavailable', 'Could not check for updates'],
  ['disabled', 'Update check disabled'],
] as const)('shows %s', (status, text) => {
  const row = show({ status, checkedAt: status === 'unavailable' ? base.checkedAt : null });
  expect(row).toHaveTextContent('0.1.2');
  expect(row).toHaveTextContent(text);
  expect(screen.queryByRole('link')).toBeNull();
});

it('uses German strings', async () => {
  await i18n.changeLanguage('de');
  try {
    show({ latest: '0.1.3', latestUrl: 'https://github.com/x/y/releases/tag/v0.1.3', status: 'update-available' });
    expect(screen.getByRole('link', { name: /^Update verfügbar: 0\.1\.3/ })).toBeInTheDocument();
  } finally {
    await i18n.changeLanguage('en');
  }
});
