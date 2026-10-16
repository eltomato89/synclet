import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UpdateStatus, VersionInfoWire } from '@synclet/shared';
import { APP_CONFIG, AppConfig } from '../config';

/** A successful answer is reused for 12 hours. */
export const UPDATE_TTL_MS = 12 * 3600_000;
/** After a failed check GitHub is asked again after 1 hour at the earliest. */
export const UPDATE_RETRY_MS = 3600_000;
export const UPDATE_TIMEOUT_MS = 5_000;

/** `1.2.3` / `v1.2.3` -> [1, 2, 3]; anything else (`edge`, `dev`, `1.2.3-rc.1`, `sha-abc`) -> null. */
export function parseVersion(v: string | null | undefined): number[] | null {
  const m = /^v?(\d+(?:\.\d+)*)$/.exec((v ?? '').trim());
  return m ? m[1].split('.').map(Number) : null;
}

/** Numeric comparison of dotted versions (`0.1.10` > `0.1.9`, `1.2` == `1.2.0`); null if either is no release. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

interface Latest { version: string; url: string }

/**
 * Asks GitHub for the latest release of SYNCLET_UPDATE_REPO, on demand (admin status), at most
 * every 12 hours (1 hour after a failure). Release builds only; never with SYNCLET_UPDATE_CHECK=off.
 * Stale-while-revalidate: `info()` never waits for GitHub; a due check runs in the background and
 * its result shows up with the next status request.
 */
@Injectable()
export class UpdateCheckService {
  private readonly log = new Logger(UpdateCheckService.name);
  /** Last successful answer. */
  private latest: (Latest & { at: number }) | null = null;
  /** Last attempt, successful or not. */
  private attempt: { at: number; ok: boolean } | null = null;
  private inflight: Promise<void> | null = null;
  /** Replaceable in tests. */
  fetch: typeof fetch = (input, init) => fetch(input, init);
  now: () => number = () => Date.now();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private due(): boolean {
    if (!this.attempt) return true;
    return this.now() - this.attempt.at >= (this.attempt.ok ? UPDATE_TTL_MS : UPDATE_RETRY_MS);
  }

  private async query(): Promise<Latest> {
    const res = await this.fetch(`https://api.github.com/repos/${this.config.updateRepo}/releases/latest`, {
      headers: { 'User-Agent': `synclet/${this.config.buildVersion}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
    const tag = typeof body.tag_name === 'string' ? body.tag_name.trim() : '';
    if (!parseVersion(tag)) throw new Error(`unexpected release tag ${JSON.stringify(body.tag_name)}`);
    const version = tag.replace(/^v/, '');
    // Only release pages of the checked repository are linked.
    const repoUrl = `https://github.com/${this.config.updateRepo}/`;
    const url = typeof body.html_url === 'string' && body.html_url.startsWith(repoUrl)
      ? body.html_url
      : `${repoUrl}releases/tag/${encodeURIComponent(tag)}`;
    return { version, url };
  }

  /** Resolves once a running check has finished (tests). */
  idle(): Promise<void> {
    return this.inflight ?? Promise.resolve();
  }

  /** Single-flight; never rejects. */
  private refresh(): Promise<void> {
    this.inflight ??= (async () => {
      const at = this.now();
      try {
        this.latest = { ...(await this.query()), at };
        this.attempt = { at, ok: true };
      } catch (e) {
        this.attempt = { at, ok: false };
        this.log.warn(`update check failed: ${(e as Error).message}`);
      }
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  info(): VersionInfoWire {
    const { buildVersion, buildRevision, updateCheck } = this.config;
    const installed = buildVersion.replace(/^v(?=\d)/, '');
    const base = { installed, revision: buildRevision, latest: null, latestUrl: null, checkedAt: null };
    if (!parseVersion(installed)) return { ...base, status: 'development' };
    if (!updateCheck) return { ...base, status: 'disabled' };
    if (this.due()) void this.refresh();
    // Not checked successfully yet (or only failures so far). A failed retry keeps showing the last known release.
    if (!this.latest) return { ...base, status: 'unavailable' };
    const checkedAt = new Date(this.latest.at).toISOString();
    const status: UpdateStatus = (compareVersions(this.latest.version, installed) ?? 0) > 0 ? 'update-available' : 'up-to-date';
    return { ...base, latest: this.latest.version, latestUrl: this.latest.url, checkedAt, status };
  }
}
