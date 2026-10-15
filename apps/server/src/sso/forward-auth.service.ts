import { Injectable, Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import { SyncError } from '../common/sync-error';
import { cidrMatcher } from './net';
import { normalizeEmail, ProvisioningService } from './provisioning.service';
import { SsoSettingsService } from './sso-settings.service';

export interface ForwardRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Direct TCP peer (never `req.ip`: X-Forwarded-For must not make a client "trusted"). */
  peer: string | undefined;
}

/** Proxies send UTF-8 bytes in headers; Node exposes them as latin1. Decode when valid UTF-8. */
function headerText(v: string): string {
  const utf8 = Buffer.from(v, 'latin1').toString('utf8');
  return utf8.includes('�') ? v : utf8;
}

/**
 * Forward-auth (trusted reverse proxy such as Authelia/Authentik outposts): identity headers are
 * honored only when the socket peer is inside `trustedProxies`.
 */
@Injectable()
export class ForwardAuthService {
  private readonly log = new Logger('ForwardAuth');

  constructor(private readonly settings: SsoSettingsService, private readonly provisioning: ProvisioningService) {}

  async authenticate(req: ForwardRequest): Promise<User> {
    const fa = (await this.settings.effective()).forwardAuth;
    if (!fa) throw new SyncError('unauthorized', 'forward-auth disabled');
    if (!cidrMatcher(fa.trustedProxies)(req.peer)) {
      this.log.debug(`ignoring forward-auth request from untrusted peer ${req.peer}`);
      throw new SyncError('unauthorized');
    }
    const get = (name: string): string | null => {
      const v = req.headers[name.toLowerCase()]; // Node joins repeated custom headers with ', '
      const t = typeof v === 'string' ? headerText(v).trim() : '';
      return t ? t : null;
    };
    const subject = get(fa.userHeader);
    if (!subject || subject.length > 256) throw new SyncError('unauthorized');
    const groups = (get(fa.groupsHeader) ?? '').split(/[,|]/).map((g) => g.trim()).filter(Boolean);
    return this.provisioning.resolve(
      {
        provider: 'forward', subject,
        // The trusted proxy asserts the email; forward-auth never links accounts by email though.
        email: normalizeEmail(get(fa.emailHeader)), emailVerified: true,
        preferredUsername: subject, name: get(fa.nameHeader), groups,
      },
      fa,
    );
  }
}
