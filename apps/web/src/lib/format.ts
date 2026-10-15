const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n: number, locale: string): string {
  let i = 0; let v = n;
  while (v >= 1024 && i < UNITS.length - 1) { v /= 1024; i++; }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)} ${UNITS[i]}`;
}

export function formatDate(iso: string, locale: string): string {
  const d = new Date(iso);
  const sameDay = new Date().toDateString() === d.toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium' }).format(d);
}
