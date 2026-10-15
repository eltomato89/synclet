import { FileX2, Loader2, PlugZap, RotateCw, Settings2, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { LogoMark } from '@/components/brand/Logo';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { apiScriptUrl, type DocEditor, loadDocsApi } from './office';
import { fetchEditorConfig } from './queries';

export type OfficeErrorKind = 'disabled' | 'unsupported' | 'notFound' | 'editorUnreachable' | 'serverUnreachable';

/** Without a sign of life from the editor by then, the Document Server is treated as unreachable. */
export const READY_TIMEOUT_MS = 60_000;

export function officeErrorKind(err: unknown): OfficeErrorKind {
  if (err instanceof ApiError) {
    // 503 from Synclet itself; a bare 503 from a proxy in front of a stopped server is not that.
    if (err.code === 'office_disabled' || (err.status === 503 && err.code !== 'server_error')) return 'disabled';
    if (err.status === 415) return 'unsupported';
    if (err.status === 404 || err.status === 400 || err.status === 403) return 'notFound';
    return 'serverUnreachable';
  }
  return 'editorUnreachable';
}

type Phase = { kind: 'loading'; title?: string } | { kind: 'ready' } | { kind: 'error'; error: OfficeErrorKind };

/**
 * Full-screen Euro-Office editor for one file, opened in its own tab. Saving is the Document
 * Server's job (callback to the Synclet server); this page only hosts the editor iframe.
 */
export function OfficeEditorPage() {
  const { itemId = '' } = useParams();
  const { i18n } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    let live = true;
    let editor: DocEditor | null = null;
    let timer: number | undefined;
    const prevTitle = document.title;
    setPhase({ kind: 'loading' });

    (async () => {
      try {
        const res = await fetchEditorConfig(itemId, i18n.language);
        const title = (res.config.document as { title?: string } | undefined)?.title ?? '';
        if (!live) return;
        if (title) { document.title = `${title} – Synclet`; setPhase({ kind: 'loading', title }); }
        const DocsAPI = await loadDocsApi(apiScriptUrl(res.documentServerUrl));
        if (!live) return;
        // The editor replaces its placeholder with an iframe: give it a node React does not own.
        const placeholder = document.createElement('div');
        placeholder.id = `office-editor-${itemId}-${attempt}`;
        container.replaceChildren(placeholder);
        const events = (res.config.events ?? {}) as Record<string, unknown>;
        const ready = () => {
          window.clearTimeout(timer);
          if (live) setPhase({ kind: 'ready' });
        };
        timer = window.setTimeout(() => { if (live) setPhase({ kind: 'error', error: 'editorUnreachable' }); }, READY_TIMEOUT_MS);
        editor = new DocsAPI.DocEditor(placeholder.id, {
          ...res.config,
          width: '100%',
          height: '100%',
          type: window.matchMedia?.('(max-width: 700px)').matches ? 'mobile' : 'desktop',
          events: { ...events, onAppReady: ready },
        });
      } catch (err) {
        if (live) setPhase({ kind: 'error', error: officeErrorKind(err) });
      }
    })();

    return () => {
      live = false;
      window.clearTimeout(timer);
      try { editor?.destroyEditor?.(); } catch { /* already gone */ }
      container.replaceChildren();
      document.title = prevTitle;
    };
    // The language is read once per attempt: switching it mid-edit must not reload the document.
  }, [itemId, attempt]);

  const failed = phase.kind === 'error';
  return (
    <main className="relative h-dvh w-full overflow-hidden bg-canvas">
      <div ref={host} className="size-full" aria-hidden={failed || undefined} hidden={failed} />
      {phase.kind === 'loading' && <Opening title={phase.title} />}
      {failed && <ErrorPanel error={phase.error} onRetry={() => setAttempt((n) => n + 1)} />}
    </main>
  );
}

function Opening({ title }: { title?: string }) {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 bg-canvas px-4" role="status">
      <LogoMark className="size-10" />
      <div className="flex max-w-sm flex-col items-center gap-1.5 text-center">
        {title && <p className="max-w-full truncate text-lg font-semibold tracking-[-0.01em]">{title}</p>}
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          {t('office.editor.opening')}
        </p>
      </div>
    </div>
  );
}

const ICONS: Record<OfficeErrorKind, typeof FileX2> = {
  disabled: Settings2, unsupported: FileX2, notFound: FileX2, editorUnreachable: PlugZap, serverUnreachable: PlugZap,
};

function ErrorPanel({ error, onRetry }: { error: OfficeErrorKind; onRetry(): void }) {
  const { t } = useTranslation();
  const Icon = ICONS[error];
  // A missing or unsupported file stays so; everything else may be fixed meanwhile (an admin sets
  // up the Document Server, the network comes back).
  const canRetry = error !== 'unsupported' && error !== 'notFound';
  // A tab the app opened can close itself; one the user opened by hand cannot, so offer the way back too.
  const close = () => {
    window.close();
    window.setTimeout(() => { if (!window.closed) window.location.assign('/files'); }, 150);
  };
  let actions: ReactNode = (
    <Button variant={canRetry ? 'outline' : 'default'} onClick={close}><X />{t('office.editor.closeTab')}</Button>
  );
  if (canRetry) actions = <><Button onClick={onRetry}><RotateCw />{t('common.retry')}</Button>{actions}</>;
  return (
    <div className="absolute inset-0 flex items-center justify-center px-4">
      <div className="w-full max-w-sm" role="alert">
        <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
        <h1 className="mt-5 text-xl font-semibold tracking-[-0.01em]">{t(`office.errors.${error}.title`)}</h1>
        <p className="mt-2 text-base text-muted-foreground">{t(`office.errors.${error}.body`)}</p>
        <div className="mt-6 flex flex-wrap gap-2">{actions}</div>
        <Link to="/files" className="mt-6 inline-block text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
          {t('office.editor.backToFiles')}
        </Link>
      </div>
    </div>
  );
}
