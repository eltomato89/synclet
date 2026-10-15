import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Plain address of a socket peer: IPv4-mapped IPv6 as IPv4, zone id and brackets removed. */
export function normalizeIp(address: string | undefined): string | null {
  if (!address) return null;
  let a = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const mapped = /^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
  if (mapped) a = mapped[1];
  return isIP(a) ? a : null;
}

export interface Cidr { address: string; prefix: number; family: 'ipv4' | 'ipv6' }

/** Parses `a.b.c.d/n`, `v6::/n` or a bare address (= host route). `/0` is refused (would trust everyone). */
export function parseCidr(input: string): Cidr | null {
  const [rawAddr, rawPrefix, ...rest] = input.trim().split('/');
  if (rest.length > 0) return null;
  const address = normalizeIp(rawAddr);
  if (!address) return null;
  const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
  const max = family === 'ipv4' ? 32 : 128;
  if (rawPrefix !== undefined && !/^\d{1,3}$/.test(rawPrefix)) return null;
  const prefix = rawPrefix === undefined ? max : Number(rawPrefix);
  if (prefix < 1 || prefix > max) return null;
  return { address, prefix, family };
}

/** Matcher for a list of CIDRs (invalid entries are ignored; validation happens on save). */
export function cidrMatcher(cidrs: string[]): (address: string | undefined) => boolean {
  const list = new BlockList();
  let any = false;
  for (const c of cidrs) {
    const p = parseCidr(c);
    if (p) { list.addSubnet(p.address, p.prefix, p.family); any = true; }
  }
  return (address) => {
    const a = normalizeIp(address);
    if (!any || !a) return false;
    return list.check(a, isIP(a) === 4 ? 'ipv4' : 'ipv6');
  };
}

const PRIVATE = cidrMatcher([
  '127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10',
  '::1/128', 'fc00::/7', 'fe80::/10',
]);

export function isPrivateAddress(address: string): boolean {
  return PRIVATE(address);
}

/** True when `host` is `localhost`, a private/loopback literal, or resolves only to such addresses. */
export async function isPrivateHost(host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (isIP(h)) return isPrivateAddress(h);
  try {
    const addrs = await lookup(h, { all: true });
    return addrs.length > 0 && addrs.every((a) => isPrivateAddress(a.address));
  } catch {
    return false;
  }
}
