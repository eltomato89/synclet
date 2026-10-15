/**
 * Rate-limit key of a client address: IPv4-mapped IPv6 as plain IPv4, other IPv6 by its /64
 * prefix (one end-user network usually owns a whole /64, so per-address keys are free to rotate).
 */
export function ipKey(ip: string | undefined): string {
  const raw = (ip ?? '').trim().split('%')[0].toLowerCase();
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1];
  if (!raw.includes(':')) return raw;
  const [head, tail] = raw.split('::');
  const groups = (part: string | undefined) => (part ? part.split(':') : []);
  const width = (g: string[]) => g.reduce((n, x) => n + (x.includes('.') ? 2 : 1), 0);
  const h = groups(head);
  const all = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - width(h) - width(groups(tail)))).fill('0'), ...groups(tail)];
  const prefix = all.slice(0, 4).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16).toString(16) : '0'));
  while (prefix.length < 4) prefix.push('0');
  return `${prefix.join(':')}::/64`;
}
