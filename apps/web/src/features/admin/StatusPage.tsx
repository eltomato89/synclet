import type { AdminStatusWire, DiskUsage, VersionInfoWire } from '@synclet/shared';
import { ExternalLink, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useTopbar } from '@/components/app-shell/Topbar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusMessage } from '@/features/files/EmptyState';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useAdminTitle } from './AdminLayout';
import { adminErrorKey } from './forms';
import { formatDateTime, formatRelative, Section } from './parts';
import { STATUS_REFRESH_MS, useAdminStatus } from './queries';

const JOB_STATES = ['pending', 'running', 'done', 'failed', 'unsupported'] as const;
const META_PARTS = [
  { key: 'derivedBytes', label: 'derived', color: 'var(--chart-1)' },
  { key: 'versionsBytes', label: 'versions', color: 'var(--chart-3)' },
  { key: 'trashBytes', label: 'trash', color: 'var(--chart-4)' },
  { key: 'uploadsBytes', label: 'uploads', color: 'var(--chart-2)' },
] as const;

/** "3 d 4 h", "5 h 12 min", "8 min". */
export function formatUptime(sec: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return t('admin.status.uptimeDays', { d, h });
  if (h) return t('admin.status.uptimeHours', { h, m });
  return t('admin.status.uptimeMinutes', { m });
}

/** Server health at a glance; refreshes every 30 seconds while open. */
export function StatusPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const status = useAdminStatus();
  useAdminTitle(t('admin.nav.status'));

  useTopbar(
    <>
      <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{t('admin.status.title')}</h1>
      {status.dataUpdatedAt > 0 && (
        <span className="text-xs text-muted-foreground tabular-nums max-sm:hidden" aria-live="polite">
          {t('admin.status.updated', { time: new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }).format(status.dataUpdatedAt) })}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void status.refetch()}
        disabled={status.isFetching}
        aria-label={t('admin.status.refresh')}
        title={t('admin.status.refreshHint', { seconds: STATUS_REFRESH_MS / 1000 })}
        className="shrink-0 text-muted-foreground"
      >
        <RefreshCw className={cn(status.isFetching && 'animate-spin')} />
      </Button>
    </>,
  );

  const s = status.data;
  if (!s && status.error) {
    return (
      <StatusMessage title={t('admin.status.loadError')} body={t(adminErrorKey(status.error))}>
        <Button variant="outline" onClick={() => void status.refetch()} disabled={status.isFetching}>{t('common.retry')}</Button>
      </StatusMessage>
    );
  }
  if (!s) {
    return (
      <div aria-hidden className="px-4 py-6 md:px-6">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="mt-8 h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="px-4 py-6 md:px-6">
      {status.error && (
        <p role="status" className="mb-4 rounded-md bg-destructive/8 px-3 py-2 text-sm text-destructive">{t('admin.status.stale')}</p>
      )}
      <Overview s={s} />

      <Section id="storage" title={t('admin.status.storage')} description={t('admin.status.storageHint')} className="mt-8 border-t pt-6!">
        <div className="grid gap-x-10 gap-y-8 lg:grid-cols-2">
          <DiskMeter label="/data" hint={t('admin.status.dataHint')} disk={s.disk.data} locale={locale} />
          <div>
            <DiskMeter label="/meta" hint={t('admin.status.metaHint')} disk={s.disk.meta} locale={locale} />
            <MetaBreakdown meta={s.meta} locale={locale} />
          </div>
        </div>
      </Section>

      <Section id="jobs" title={t('admin.status.jobs')} description={t('admin.status.jobsHint')} className="border-t">
        <div className="overflow-x-auto rounded-lg border">
          <table aria-label={t('admin.status.jobs')} className="w-full min-w-[40rem] border-separate border-spacing-0 text-sm">
            <thead className="bg-canvas text-xs text-muted-foreground">
              <tr className="[&>th]:h-8 [&>th]:border-b [&>th]:px-3 [&>th]:font-medium">
                <th scope="col" className="text-left">{t('admin.status.queue')}</th>
                {JOB_STATES.map((st) => <th key={st} scope="col" className="w-28 text-right whitespace-nowrap">{t(`admin.status.jobState.${st}`)}</th>)}
              </tr>
            </thead>
            <tbody>
              {(['thumb', 'text'] as const).map((kind, i) => (
                <tr key={kind} className={cn('h-11', i === 0 && '[&>*]:border-b [&>*]:border-border/70')}>
                  <th scope="row" className="px-3 text-left font-medium text-foreground">{t(`admin.status.jobKind.${kind}`)}</th>
                  {JOB_STATES.map((st) => {
                    const n = s.jobs[kind][st];
                    return (
                      <td
                        key={st}
                        className={cn(
                          'px-3 text-right tabular-nums',
                          n === 0 ? 'text-muted-foreground/60' : st === 'failed' ? 'font-medium text-destructive' : st === 'pending' || st === 'running' ? 'font-medium text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {new Intl.NumberFormat(locale).format(n)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function Overview({ s }: { s: AdminStatusWire }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const office = !s.office.enabled ? 'off' : s.office.reachable === null ? 'unknown' : s.office.reachable ? 'ok' : 'down';
  return (
    <dl className="grid grid-cols-2 overflow-hidden rounded-xl border sm:grid-cols-3 xl:grid-cols-6 [&>div]:-mb-px [&>div]:-ml-px [&>div]:border-b [&>div]:border-l">
      <Reading label={t('admin.status.watcher')} tone={s.watch === 'active' ? 'ok' : s.watch === 'off' ? 'warn' : 'neutral'}
        detail={t(`admin.status.watchHint.${s.watch}`)}
      >
        {t(`admin.status.watch.${s.watch}`)}
      </Reading>
      <Reading label={t('admin.status.lastScan')} detail={s.lastFullScanAt ? formatDateTime(s.lastFullScanAt, locale) : undefined}>
        {s.lastFullScanAt ? formatRelative(s.lastFullScanAt, locale) : t('admin.status.noScan')}
      </Reading>
      <Reading label={t('admin.status.users')} detail={s.users.disabled ? t('admin.status.usersDisabled', { count: s.users.disabled }) : undefined}>
        {new Intl.NumberFormat(locale).format(s.users.total - s.users.disabled)}
      </Reading>
      <Reading label={t('admin.status.office')} tone={office === 'ok' ? 'ok' : office === 'down' ? 'bad' : 'neutral'}>
        {t(`admin.status.officeState.${office}`)}
      </Reading>
      <Reading label={t('admin.status.versions')} detail={s.versions ? undefined : t('admin.status.versionsHint')}>
        {s.versions ? t('admin.status.on') : t('admin.status.off')}
      </Reading>
      <VersionReading version={s.version} uptimeSec={s.uptimeSec} />
    </dl>
  );
}

/** Installed version, update state (link to the release notes if newer) and uptime. */
export function VersionReading({ version: v, uptimeSec }: { version: VersionInfoWire; uptimeSec: number }) {
  const { t, i18n } = useTranslation();
  const dev = v.status === 'development';
  const rev = v.revision ? v.revision.slice(0, 7) : null;
  const checked = v.checkedAt ? t('admin.status.updateChecked', { time: formatDateTime(v.checkedAt, i18n.language) }) : undefined;
  const state = dev
    ? <span className="tabular-nums">{[v.installed, rev].filter(Boolean).join(' · ')}</span>
    : v.status === 'update-available' && v.latest
      ? (
        <a
          href={v.latestUrl ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
          title={checked}
          className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {t('admin.status.update.update-available', { latest: v.latest })}
          <ExternalLink aria-hidden className="size-3 shrink-0" />
          {' '}<span className="sr-only">{t('admin.status.newTab')}</span>
        </a>
      )
      : <span title={checked}>{t(`admin.status.update.${v.status}`)}</span>;
  return (
    <Reading
      label={t('admin.status.server')}
      tone={v.status === 'up-to-date' ? 'ok' : v.status === 'update-available' ? 'warn' : 'neutral'}
      detail={<><span className="block truncate">{state}</span><span className="block">{t('admin.status.uptime', { time: formatUptime(uptimeSec, t) })}</span></>}
    >
      {dev ? t('admin.status.update.development') : <span className="tabular-nums">{v.installed}</span>}
    </Reading>
  );
}

function Reading({ label, children, detail, tone = 'neutral' }: { label: string; children: ReactNode; detail?: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'neutral' }) {
  return (
    <div className="min-w-0 px-4 py-3.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex items-center gap-2 text-base font-medium text-foreground">
        {tone !== 'neutral' && (
          <span
            aria-hidden
            className={cn('size-2 shrink-0 rounded-full', tone === 'ok' && 'bg-primary', tone === 'warn' && 'bg-chart-4', tone === 'bad' && 'bg-destructive')}
          />
        )}
        <span className="truncate">{children}</span>
      </dd>
      {detail && <dd className="mt-0.5 text-xs text-muted-foreground">{detail}</dd>}
    </div>
  );
}

function DiskMeter({ label, hint, disk, locale }: { label: string; hint: string; disk: DiskUsage; locale: string }) {
  const { t } = useTranslation();
  const known = disk.totalBytes > 0;
  const used = Math.max(0, disk.totalBytes - disk.freeBytes);
  const pct = known ? Math.min(100, (used / disk.totalBytes) * 100) : 0;
  const tight = pct >= 90;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <span className="text-sm font-semibold text-foreground">{label}</span>
          <span className="ml-2 text-xs text-muted-foreground">{hint}</span>
        </div>
        {known && (
          <span className={cn('shrink-0 text-sm font-medium tabular-nums', tight ? 'text-destructive' : 'text-foreground')}>
            {new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(pct / 100)}
          </span>
        )}
      </div>
      <div
        role="meter"
        aria-label={t('admin.status.diskLabel', { path: label })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={known ? t('admin.status.diskOf', { used: formatBytes(used, locale), total: formatBytes(disk.totalBytes, locale) }) : t('admin.status.diskUnknown')}
        className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className={cn('h-full rounded-full transition-[width] duration-300', tight ? 'bg-destructive' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-xs text-muted-foreground tabular-nums">
        {known
          ? t('admin.status.diskFree', { used: formatBytes(used, locale), total: formatBytes(disk.totalBytes, locale), free: formatBytes(disk.freeBytes, locale) })
          : t('admin.status.diskUnknown')}
      </p>
    </div>
  );
}

function MetaBreakdown({ meta, locale }: { meta: AdminStatusWire['meta']; locale: string }) {
  const { t } = useTranslation();
  const total = META_PARTS.reduce((n, p) => n + meta[p.key], 0);
  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-xs font-medium text-foreground">{t('admin.status.metaBreakdown')}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{formatBytes(total, locale)}</span>
      </div>
      <div aria-hidden className="mt-2 flex h-2 gap-px overflow-hidden rounded-full bg-muted">
        {total > 0 && META_PARTS.map((p) => meta[p.key] > 0 && (
          <div key={p.key} style={{ width: `${(meta[p.key] / total) * 100}%`, background: p.color }} className="h-full min-w-1" />
        ))}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
        {META_PARTS.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <span aria-hidden className="size-2 shrink-0 rounded-[2px]" style={{ background: p.color }} />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{t(`admin.status.meta.${p.label}`)}</span>
            <span className="text-foreground tabular-nums">{formatBytes(meta[p.key], locale)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
