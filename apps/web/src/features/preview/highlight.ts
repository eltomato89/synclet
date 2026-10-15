import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * highlight.js core with exactly the languages the server reports in `preview.language`
 * (apps/server/src/derivatives/preview-kind.ts). Loaded as its own chunk by CodeViewer.
 */
const LANGUAGES = { bash, c, cpp, csharp, css, go, ini, java, javascript, json, kotlin, php, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, lang);

export const registeredLanguages = Object.keys(LANGUAGES);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Highlighted HTML (escaped by highlight.js); plain escaped text for unknown languages. */
export function highlight(text: string, language: string | undefined): string {
  if (!language || !hljs.getLanguage(language)) return escapeHtml(text);
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}
