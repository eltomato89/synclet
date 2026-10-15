import { type ComponentType, useCallback, useState } from 'react';
import type { PreviewSource } from '../source';
import { CodeViewer } from './CodeViewer';
import { NoPreview, type ViewerProps } from './common';
import { ImageViewer, imageCandidates } from './ImageViewer';
import { MarkdownViewer } from './MarkdownViewer';
import { MediaViewer } from './MediaViewer';
import { PdfViewer } from './PdfViewer';
import { TextViewer } from './TextViewer';

export type ViewerKey = 'image' | 'pdf' | 'text' | 'markdown' | 'code' | 'media' | 'none';

/** Which viewer shows a source. Anything that cannot be shown safely falls back to 'none'. */
export function viewerKey(source: PreviewSource): ViewerKey {
  switch (source.kind) {
    case 'image': return imageCandidates(source).length > 0 ? 'image' : 'none';
    case 'pdf': return 'pdf';
    case 'text': case 'markdown': case 'code': return source.loadText ? source.kind : 'none';
    case 'video': case 'audio': return 'media';
    default: return 'none';
  }
}

export const VIEWERS: Record<Exclude<ViewerKey, 'none'>, ComponentType<ViewerProps>> = {
  image: ImageViewer,
  pdf: PdfViewer,
  text: TextViewer,
  markdown: MarkdownViewer,
  code: CodeViewer,
  media: MediaViewer,
};

/** The viewer for a source, falling back to the "no preview" panel when it gives up. */
export function PreviewStage({ source, onDownload }: { source: PreviewSource; onDownload?(): void }) {
  const [failed, setFailed] = useState(false);
  const onUnavailable = useCallback(() => setFailed(true), []);
  const key = viewerKey(source);
  if (key === 'none' || failed) return <NoPreview source={source} failed={failed} onDownload={onDownload} />;
  const Viewer = VIEWERS[key];
  return <Viewer source={source} onUnavailable={onUnavailable} onDownload={onDownload} />;
}
