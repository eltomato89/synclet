import { ipKey } from './ip-key';

describe('ipKey', () => {
  it('keys IPv4 as is, IPv4-mapped IPv6 as IPv4 and IPv6 by /64', () => {
    expect(ipKey('192.0.2.1')).toBe('192.0.2.1');
    expect(ipKey('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(ipKey('0:0:0:0:0:ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(ipKey('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('2001:db8:1:2:3:4:192.0.2.1')).toBe('2001:db8:1:2::/64');
    expect(ipKey(undefined)).toBe('');
  });
});
