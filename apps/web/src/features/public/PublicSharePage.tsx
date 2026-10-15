import type { PublicShareEntry } from '@synclet/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Clock, Download, Eye, Link2Off, LockKeyhole, ShieldCheck, WifiOff } from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/auth/FormError';
import { PasswordInput } from '@/components/auth/PasswordInput';
import { Rings, Wordmark } from '@/components/brand/Logo';
import { FullPageSpinner } from '@/components/FullPageSpinner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { fetchShareInfo, listShareItems, PublicError, type ShareInfo, shareUrls, unlockShare } from './api';
import { type Crumb, FolderBrowser } from './FolderBrowser';
import { type GateError, gateReducer, initialGate } from './gate';
import { publicPreviewSource } from './preview';
import { PreviewStage, viewers } from './PreviewViewer';
import { PublicUploadZone } from './PublicUploadZone';
import { QuickLook } from './QuickLook';

// ---------------------------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------------------------

/** Keeps share pages out of search engines and the token out of Referer headers; sets the tab title. */
function useShareDocument(title: string) {
  useEffect(() => {
    const robots = Object.assign(document.createElement('meta'), { name: 'robots', content: 'noindex, nofollow' });
    const referrer = Object.assign(document.createElement('meta'), { name: 'referrer', content: 'no-referrer' });
    document.head.append(robots, referrer);
    return () => { robots.remove(); referrer.remove(); };
  }, []);
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => { document.title = previous; };
  }, [title]);
}

function useSecondsUntil(at: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!at) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [at]);
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

function Frame({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-x-clip bg-canvas">
      <header className="px-4 pt-5 sm:px-8 sm:pt-7">
        <Wordmark />
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 pt-10 pb-16 sm:px-8 sm:pt-14">{children}</main>
      <footer className="flex items-center gap-2 px-4 pb-5 text-xs text-muted-foreground sm:px-8 sm:pb-7">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
        {t('publicShare.footer')}
      </footer>
    </div>
  );
}

/** Rings of the Synclet mark radiating from whatever sits at their centre (sender or state icon). */
function Radiating({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('relative inline-flex self-start', className)}>
      <Rings className="absolute top-1/2 left-1/2 -z-10 w-[1000px] max-w-none -translate-x-1/2 -translate-y-1/2 text-border" />
      {children}
    </span>
  );
}

function StateIcon({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'primary' }) {
  return (
    <Radiating>
      <span className={cn(
        'flex size-12 items-center justify-center rounded-full border bg-background [&_svg]:size-5',
        tone === 'primary' ? 'text-primary' : 'text-muted-foreground',
      )}
      >
        {children}
      </span>
    </Radiating>
  );
}

/** Small centred column for everything that is not the share itself: gate, gone, errors. */
function StateScreen({ icon, tone, title, body, children }: { icon: ReactNode; tone?: 'muted' | 'primary'; title: string; body?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center pb-[8vh]">
      <StateIcon tone={tone}>{icon}</StateIcon>
      <h1 className="mt-7 text-2xl font-semibold tracking-[-0.02em]">{title}</h1>
      {body && <p className="mt-2 text-base text-muted-foreground">{body}</p>}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Gate states
// ---------------------------------------------------------------------------------------------

function gateErrorText(t: (k: string, o?: Record<string, unknown>) => string, error: GateError | null, seconds: number): string | null {
  if (!error) return null;
  if (error === 'rate_limited' || error === 'busy') {
    return seconds > 0 ? t('publicShare.errors.rateLimitedWait', { count: seconds }) : t('publicShare.errors.rateLimited');
  }
  return t(`publicShare.errors.${error}`);
}

function PasswordGate({ token, unlocking, error, retryAt, relock, onUnlock, onFailed, onUnlocked }: {
  token: string; unlocking: boolean; error: GateError | null; retryAt: number | null; relock: boolean;
  onUnlock(): void; onFailed(e: unknown): void; onUnlocked(): void;
}) {
  const { t } = useTranslation();
  const seconds = useSecondsUntil(retryAt);
  const waiting = seconds > 0;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    if (!password || unlocking || waiting) return;
    onUnlock();
    try {
      await unlockShare(token, password);
      onUnlocked();
    } catch (err) {
      onFailed(err);
    }
  }

  return (
    <StateScreen
      icon={<LockKeyhole />}
      tone="primary"
      title={t('publicShare.gate.title')}
      body={relock ? t('publicShare.gate.relock') : t('publicShare.gate.body')}
    >
      <form onSubmit={(e) => void submit(e)} className="mt-7 rounded-xl border bg-background p-5 sm:p-6" noValidate>
        <div className="grid gap-2">
          <Label htmlFor="share-password">{t('publicShare.gate.password')}</Label>
          <PasswordInput
            id="share-password" name="password" autoComplete="off" autoFocus required
            aria-invalid={error === 'wrong_password' || undefined}
          />
        </div>
        <div className="mt-4" aria-live="polite">
          <FormError>{gateErrorText(t, error, seconds)}</FormError>
        </div>
        <Button type="submit" className="mt-4 w-full" disabled={unlocking || waiting}>
          {unlocking ? t('publicShare.gate.opening') : t('publicShare.gate.open')}
        </Button>
      </form>
    </StateScreen>
  );
}

function GoneScreen({ reason }: { reason: 'not_found' | 'expired' }) {
  const { t } = useTranslation();
  return reason === 'expired'
    ? <StateScreen icon={<Clock />} title={t('publicShare.gone.expiredTitle')} body={t('publicShare.gone.expiredBody')} />
    : <StateScreen icon={<Link2Off />} title={t('publicShare.gone.notFoundTitle')} body={t('publicShare.gone.notFoundBody')} />;
}

function FailedScreen({ error, retryAt, onRetry }: { error: GateError; retryAt: number | null; onRetry(): void }) {
  const { t } = useTranslation();
  const seconds = useSecondsUntil(retryAt);
  const limited = error === 'rate_limited' || error === 'busy';
  return (
    <StateScreen
      icon={limited ? <Clock /> : <WifiOff />}
      title={limited ? t('publicShare.failed.rateLimitedTitle') : t('publicShare.failed.title')}
      body={limited ? gateErrorText(t, error, seconds) : t(`publicShare.errors.${error}`)}
    >
      <Button variant="outline" className="mt-6 self-start" onClick={onRetry} disabled={seconds > 0}>
        {t('common.retry')}
      </Button>
    </StateScreen>
  );
}

// ---------------------------------------------------------------------------------------------
// Share content
// ---------------------------------------------------------------------------------------------

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const first = [...words[0]][0] ?? '';
  const last = words.length > 1 ? [...words[words.length - 1]][0] ?? '' : '';
  return (first + last).toUpperCase();
}

function Hero({ token, info }: { token: string; info: ShareInfo }) {
  const { t, i18n } = useTranslation();
  const urls = shareUrls(token);
  const expires = info.expiresAt
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'long' }).format(new Date(info.expiresAt))
    : null;
  return (
    <section className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <Radiating>
            <span aria-hidden className="flex size-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
              {initials(info.ownerDisplayName)}
            </span>
          </Radiating>
          <p className="text-base text-muted-foreground">
            <Trans
              i18nKey={info.type === 'folder' ? 'publicShare.sharedFolder' : 'publicShare.sharedFile'}
              values={{ name: info.ownerDisplayName }}
              components={{ b: <strong className="font-semibold text-foreground" /> }}
            />
          </p>
        </div>
        <h1 className="mt-5 text-[1.75rem] leading-tight font-semibold tracking-[-0.022em] break-words sm:text-[2rem]">{info.name}</h1>
        <ul className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground tabular-nums">
          <li>{formatBytes(info.size, i18n.language)}</li>
          {expires && (
            <li className="inline-flex items-center gap-1.5">
              <CalendarClock className="size-3.5" aria-hidden />
              {t('publicShare.expires', { date: expires })}
            </li>
          )}
          {!info.allowDownload && (
            <li className="inline-flex items-center gap-1.5">
              <Eye className="size-3.5" aria-hidden />
              {t('publicShare.viewOnly')}
            </li>
          )}
        </ul>
      </div>
      {info.allowDownload && (
        <Button asChild size="lg" className="shrink-0 self-start px-4 sm:self-auto">
          <a href={info.type === 'folder' ? urls.zip() : urls.content(info.id ?? '', { download: true })} download>
            <Download />
            {info.type === 'folder' ? t('publicShare.downloadAll') : t('publicShare.download')}
          </a>
        </Button>
      )}
    </section>
  );
}

function FileShare({ token, info }: { token: string; info: ShareInfo }) {
  const source = useMemo(
    () => publicPreviewSource(token, { id: info.id ?? '', name: info.name, size: info.size, mime: info.mime }, info.allowDownload),
    [token, info],
  );
  const tall = !!viewers[source.kind] && source.kind !== 'audio';
  return (
    <div className={cn('mt-8 flex overflow-hidden rounded-xl border bg-background', tall ? 'h-[min(72dvh,780px)]' : 'min-h-[380px]')}>
      <PreviewStage source={source} className="flex-1 p-4 sm:p-6" />
    </div>
  );
}

interface NavState { trail?: Crumb[] }

function FolderShare({ token, info, onShareError }: { token: string; info: ShareInfo; onShareError(e: unknown): void }) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const folderId = new URLSearchParams(location.search).get('folder');
  const stateTrail = (location.state as NavState | null)?.trail;
  // Ancestor names come from navigation state; after a reload without it, the folder shows as "…".
  const trail: Crumb[] = useMemo(() => {
    const root: Crumb = { id: null, name: info.name };
    if (!folderId) return [root];
    if (stateTrail?.length && stateTrail[stateTrail.length - 1].id === folderId) return [root, ...stateTrail];
    return [root, { id: folderId, name: '' }];
  }, [folderId, stateTrail, info.name]);

  const go = useCallback((next: Crumb[]) => {
    const target = next[next.length - 1]?.id;
    navigate({ search: target ? `?folder=${encodeURIComponent(target)}` : '' }, { state: { trail: next } satisfies NavState });
  }, [navigate]);

  const query = useQuery({
    queryKey: ['publicShare', token, 'items', folderId ?? ''],
    queryFn: ({ signal }) => listShareItems(token, folderId, signal),
    retry: (n, e) => n < 2 && e instanceof PublicError && e.code === 'network',
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    const e = query.error;
    if (!e) return;
    if (e instanceof PublicError && e.status === 404 && folderId) {
      // The subfolder is gone (moved out, deleted): back to the top of the share.
      toast.info(t('publicShare.folderGone'));
      navigate({ search: '' }, { replace: true, state: { trail: [] } satisfies NavState });
      return;
    }
    if (e instanceof PublicError && (e.status === 404 || e.status === 410 || e.code === 'share_password_required')) onShareError(e);
  }, [query.error, folderId, navigate, onShareError, t]);

  const files = useMemo(() => (query.data ?? []).filter((x) => x.type === 'file'), [query.data]);
  const sources = useMemo(() => files.map((f) => publicPreviewSource(token, f, info.allowDownload)), [files, token, info.allowDownload]);
  const [lookIndex, setLookIndex] = useState<number | null>(null);
  useEffect(() => { setLookIndex(null); }, [folderId]);

  const open = (entry: PublicShareEntry) => {
    if (entry.type === 'folder') go([...trail.slice(1), { id: entry.id, name: entry.name }]);
    else setLookIndex(files.findIndex((f) => f.id === entry.id));
  };

  const onUploaded = useCallback((_: PublicShareEntry, folder: string | null) => {
    void queryClient.invalidateQueries({ queryKey: ['publicShare', token, 'items', folder ?? ''] });
  }, [queryClient, token]);

  const current = trail[trail.length - 1];
  const errorText = query.error && !(query.error instanceof PublicError && [401, 404, 410].includes(query.error.status))
    ? (query.error instanceof PublicError && (query.error.status === 429 || query.error.code === 'busy')
      ? t('publicShare.errors.rateLimited')
      : t('publicShare.errors.listing'))
    : null;

  return (
    <>
      <div className="mt-8">
        <FolderBrowser
          token={token}
          trail={trail}
          items={query.data}
          loading={query.isPending}
          error={errorText}
          allowDownload={info.allowDownload}
          emptyHint={info.allowUpload ? t('publicShare.emptyUpload') : null}
          onNavigate={(depth) => go(trail.slice(1, depth + 1))}
          onOpen={open}
          onRetry={() => void query.refetch()}
        />
      </div>
      {info.allowUpload && (
        <PublicUploadZone
          token={token}
          folderId={folderId}
          folderName={current.name || info.name}
          onUploaded={onUploaded}
          onShareError={onShareError}
        />
      )}
      <QuickLook sources={sources} index={lookIndex} onIndex={setLookIndex} onClose={() => setLookIndex(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------------------------

/**
 * Public page of a share link (`/s/:token`), outside the app shell and without any session:
 * every request goes to `/api/public/shares/:token` (see ./api.ts).
 */
export function PublicSharePage() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [gate, dispatch] = useReducer(gateReducer, initialGate);

  useShareDocument(gate.status === 'open' ? `${gate.info.name} – Synclet` : 'Synclet');

  useEffect(() => {
    if (gate.status !== 'loading') return;
    const ac = new AbortController();
    fetchShareInfo(token, ac.signal).then(
      (info) => dispatch({ type: 'loaded', info }),
      (error: unknown) => { if (!ac.signal.aborted) dispatch({ type: 'failed', error, now: Date.now() }); },
    );
    return () => ac.abort();
  }, [gate.status, token]);

  // Content fetched under an earlier unlock must not survive a re-lock.
  useEffect(() => {
    if (gate.status === 'locked' || gate.status === 'gone') queryClient.removeQueries({ queryKey: ['publicShare', token] });
  }, [gate.status, queryClient, token]);

  const onShareError = useCallback((error: unknown) => dispatch({ type: 'failed', error, now: Date.now() }), []);

  let content: ReactNode;
  switch (gate.status) {
    case 'loading':
      return <FullPageSpinner />;
    case 'locked':
      content = (
        <PasswordGate
          token={token}
          unlocking={gate.unlocking}
          error={gate.error}
          retryAt={gate.retryAt}
          relock={gate.relock}
          onUnlock={() => dispatch({ type: 'unlock' })}
          onFailed={(error) => dispatch({ type: 'unlockFailed', error, now: Date.now() })}
          onUnlocked={() => dispatch({ type: 'unlocked' })}
        />
      );
      break;
    case 'gone':
      content = <GoneScreen reason={gate.reason} />;
      break;
    case 'failed':
      content = <FailedScreen error={gate.error} retryAt={gate.retryAt} onRetry={() => dispatch({ type: 'retry' })} />;
      break;
    case 'open':
      content = (
        <div aria-label={t('publicShare.region')} role="region">
          <Hero token={token} info={gate.info} />
          {gate.info.type === 'folder'
            ? <FolderShare token={token} info={gate.info} onShareError={onShareError} />
            : <FileShare token={token} info={gate.info} />}
        </div>
      );
      break;
  }
  return <Frame>{content}</Frame>;
}
