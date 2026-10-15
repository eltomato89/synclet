import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthSettings, Prisma } from '@prisma/client';
import type { LoginMethods, SsoSettingsWire } from '@synclet/shared';
import { z } from 'zod';
import { APP_CONFIG, AppConfig } from '../config';
import { SecretBox } from '../common/secret-box';
import { SyncError } from '../common/sync-error';
import { PrismaService } from '../prisma/prisma.service';
import { ServerConfigService } from '../auth/server-config.service';
import { discoverOidc, issuerProblem } from './oidc-client';
import { parseCidr } from './net';

/** SecretBox purpose (HKDF info and AAD) of the stored OIDC client secret. */
export const OIDC_SECRET_PURPOSE = 'oidc-client-secret';
export const OIDC_CALLBACK_PATH = '/api/auth/oidc/callback';

const groups = z.array(z.string().trim().min(1).max(200)).max(100);
const header = z.string().trim().max(100).regex(/^[A-Za-z0-9-]+$/, 'header names may only contain letters, digits and "-"');
const claim = z.string().trim().min(1).max(100).regex(/^\S+$/, 'claim names must not contain whitespace');

export const SsoSettingsInputSchema = z.object({
  passwordLoginForUsers: z.boolean().optional(),
  oidc: z.object({
    enabled: z.boolean().optional(),
    issuer: z.string().trim().max(500).nullable().optional(),
    clientId: z.string().trim().max(500).nullable().optional(),
    clientSecret: z.string().max(4000).nullable().optional(),
    scopes: z.string().trim().min(1).max(500).optional(),
    buttonLabel: z.string().trim().min(1).max(60).optional(),
    usernameClaim: claim.optional(),
    groupsClaim: claim.optional(),
    allowedGroups: groups.optional(),
    adminGroups: groups.optional(),
    linkByEmail: z.boolean().optional(),
  }).strict().optional(),
  forwardAuth: z.object({
    enabled: z.boolean().optional(),
    userHeader: header.optional(),
    emailHeader: header.optional(),
    nameHeader: header.optional(),
    groupsHeader: header.optional(),
    trustedProxies: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
    allowedGroups: groups.optional(),
    adminGroups: groups.optional(),
  }).strict().optional(),
}).strict();
export type SsoSettingsInputParsed = z.infer<typeof SsoSettingsInputSchema>;

/** Gates applied by provisioning for one SSO source. */
export interface SsoPolicy { allowedGroups: string[]; adminGroups: string[]; linkByEmail: boolean }

export interface EffectiveOidc extends SsoPolicy {
  issuer: string;
  clientId: string;
  clientSecretEnc: string | null;
  scopes: string;
  buttonLabel: string;
  usernameClaim: string;
  groupsClaim: string;
  redirectUri: string;
  /** Changes whenever the settings row changes (cache key for the discovered client). */
  version: number;
}

export interface EffectiveForwardAuth extends SsoPolicy {
  userHeader: string;
  emailHeader: string;
  nameHeader: string;
  groupsHeader: string;
  trustedProxies: string[];
}

/** Settings as they apply right now (`SYNCLET_SSO_EMERGENCY=1` turns SSO off and password login on). */
export interface EffectiveSso {
  emergency: boolean;
  passwordLoginForUsers: boolean;
  oidc: EffectiveOidc | null;
  forwardAuth: EffectiveForwardAuth | null;
}

/** Password login rule: admins always; everyone else unless disabled by the admin (and not in emergency mode). */
export function isPasswordLoginAllowed(user: { role: 'admin' | 'user' }, effective: EffectiveSso): boolean {
  return user.role === 'admin' || effective.passwordLoginForUsers;
}

/** Runtime SSO configuration (single `AuthSettings` row), cached in memory and invalidated on update. */
@Injectable()
export class SsoSettingsService {
  private readonly log = new Logger('SsoSettings');
  private cache?: Promise<AuthSettings>;
  private box?: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly serverConfig: ServerConfigService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private row(): Promise<AuthSettings> {
    if (!this.cache) {
      const p = this.prisma.authSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
      p.catch(() => { if (this.cache === p) this.cache = undefined; });
      this.cache = p;
    }
    return this.cache;
  }

  invalidate(): void { this.cache = undefined; }

  /** `${SYNCLET_PUBLIC_URL}/api/auth/oidc/callback`, or '' without a public URL (OIDC then cannot be enabled). */
  redirectUri(): string {
    return this.config.publicUrl ? `${this.config.publicUrl.replace(/\/+$/, '')}${OIDC_CALLBACK_PATH}` : '';
  }

  private async secretBox(): Promise<SecretBox> {
    this.box ??= new SecretBox((await this.serverConfig.get()).jwtSecret);
    return this.box;
  }

  async openClientSecret(enc: string | null): Promise<string | null> {
    return enc ? (await this.secretBox()).open(enc, OIDC_SECRET_PURPOSE) : null;
  }

  private toWire(r: AuthSettings): SsoSettingsWire {
    return {
      passwordLoginForUsers: r.passwordLoginForUsers,
      oidc: {
        enabled: r.oidcEnabled, issuer: r.oidcIssuer, clientId: r.oidcClientId, hasClientSecret: r.oidcClientSecretEnc !== null,
        scopes: r.oidcScopes, buttonLabel: r.oidcButtonLabel, usernameClaim: r.oidcUsernameClaim, groupsClaim: r.oidcGroupsClaim,
        allowedGroups: r.oidcAllowedGroups, adminGroups: r.oidcAdminGroups, linkByEmail: r.oidcLinkByEmail, redirectUri: this.redirectUri(),
      },
      forwardAuth: {
        enabled: r.forwardAuthEnabled, userHeader: r.forwardAuthUserHeader, emailHeader: r.forwardAuthEmailHeader,
        nameHeader: r.forwardAuthNameHeader, groupsHeader: r.forwardAuthGroupsHeader, trustedProxies: r.forwardAuthTrustedProxies,
        allowedGroups: r.forwardAuthAllowedGroups, adminGroups: r.forwardAuthAdminGroups,
      },
      emergency: this.config.ssoEmergency,
    };
  }

  async get(): Promise<SsoSettingsWire> {
    return this.toWire(await this.row());
  }

  async effective(): Promise<EffectiveSso> {
    const r = await this.row();
    const emergency = this.config.ssoEmergency;
    const redirectUri = this.redirectUri();
    const oidcOn = !emergency && r.oidcEnabled && !!r.oidcIssuer && !!r.oidcClientId && !!redirectUri;
    return {
      emergency,
      passwordLoginForUsers: emergency || r.passwordLoginForUsers,
      oidc: oidcOn ? {
        issuer: r.oidcIssuer!, clientId: r.oidcClientId!, clientSecretEnc: r.oidcClientSecretEnc, scopes: r.oidcScopes,
        buttonLabel: r.oidcButtonLabel, usernameClaim: r.oidcUsernameClaim, groupsClaim: r.oidcGroupsClaim, redirectUri,
        allowedGroups: r.oidcAllowedGroups, adminGroups: r.oidcAdminGroups, linkByEmail: r.oidcLinkByEmail,
        version: r.updatedAt.getTime(),
      } : null,
      forwardAuth: !emergency && r.forwardAuthEnabled ? {
        userHeader: r.forwardAuthUserHeader, emailHeader: r.forwardAuthEmailHeader, nameHeader: r.forwardAuthNameHeader,
        groupsHeader: r.forwardAuthGroupsHeader, trustedProxies: r.forwardAuthTrustedProxies,
        allowedGroups: r.forwardAuthAllowedGroups, adminGroups: r.forwardAuthAdminGroups, linkByEmail: false,
      } : null,
    };
  }

  /** For password login paths (web login, app authorize): see `isPasswordLoginAllowed`. */
  async isPasswordLoginAllowed(user: { role: 'admin' | 'user' }): Promise<boolean> {
    return isPasswordLoginAllowed(user, await this.effective());
  }

  async loginMethods(): Promise<LoginMethods> {
    const e = await this.effective();
    return {
      password: e.passwordLoginForUsers,
      oidc: { enabled: e.oidc !== null, label: e.oidc?.buttonLabel ?? (await this.row()).oidcButtonLabel },
      forwardAuth: e.forwardAuth !== null,
      emergency: e.emergency,
    };
  }

  async update(input: SsoSettingsInputParsed, by: string): Promise<SsoSettingsWire> {
    const cur = await this.prisma.authSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
    const o = input.oidc ?? {};
    const f = input.forwardAuth ?? {};
    const bad = (message: string) => new SyncError('invalid_request', message);

    const issuer = o.issuer === undefined ? cur.oidcIssuer : o.issuer || null;
    const clientId = o.clientId === undefined ? cur.oidcClientId : o.clientId || null;
    const scopes = o.scopes ?? cur.oidcScopes;
    const oidcEnabled = o.enabled ?? cur.oidcEnabled;
    if (issuer !== null && issuer !== cur.oidcIssuer) {
      const problem = await issuerProblem(issuer, this.config.ssoAllowHttpIssuer);
      if (problem) throw bad(problem);
      if (issuer.startsWith('http:')) this.log.warn(`OIDC issuer ${issuer} uses plain http (allowed by SYNCLET_SSO_ALLOW_HTTP_ISSUER)`);
    }
    if (o.scopes !== undefined && (!scopes.split(/\s+/).includes('openid') || !/^[\x21-\x7e]+( [\x21-\x7e]+)*$/.test(scopes))) {
      throw bad('scopes must be space-separated and include "openid"');
    }

    const trustedProxies = f.trustedProxies ?? cur.forwardAuthTrustedProxies;
    for (const c of f.trustedProxies ?? []) {
      if (!parseCidr(c)) throw bad(`invalid trusted proxy CIDR: ${c}`);
    }
    const forwardEnabled = f.enabled ?? cur.forwardAuthEnabled;
    if (forwardEnabled && trustedProxies.length === 0) throw bad('forward-auth needs at least one trusted proxy CIDR');

    let clientSecretEnc: string | null | undefined;
    if (o.clientSecret === null || o.clientSecret === '') clientSecretEnc = null;
    else if (o.clientSecret !== undefined) clientSecretEnc = (await this.secretBox()).seal(o.clientSecret, OIDC_SECRET_PURPOSE);

    if (oidcEnabled) {
      if (!this.config.publicUrl) throw bad('OIDC needs SYNCLET_PUBLIC_URL (redirect URI)');
      if (!issuer) throw bad('OIDC needs an issuer');
      if (!clientId) throw bad('OIDC needs a client id');
      const changed = !cur.oidcEnabled || issuer !== cur.oidcIssuer || clientId !== cur.oidcClientId || clientSecretEnc !== undefined;
      if (changed) {
        const secret = clientSecretEnc === undefined ? await this.openClientSecret(cur.oidcClientSecretEnc).catch(() => null) : o.clientSecret || null;
        try {
          await discoverOidc({ issuer, clientId, clientSecret: secret }, this.config.ssoAllowHttpIssuer);
        } catch (e) {
          throw bad(`OIDC discovery failed: ${errorMessage(e)}`);
        }
      }
    }

    const data: Prisma.AuthSettingsUpdateInput = {
      passwordLoginForUsers: input.passwordLoginForUsers,
      oidcEnabled: o.enabled,
      oidcIssuer: o.issuer === undefined ? undefined : issuer,
      oidcClientId: o.clientId === undefined ? undefined : clientId,
      oidcClientSecretEnc: clientSecretEnc,
      oidcScopes: o.scopes,
      oidcButtonLabel: o.buttonLabel,
      oidcUsernameClaim: o.usernameClaim,
      oidcGroupsClaim: o.groupsClaim,
      oidcAllowedGroups: o.allowedGroups,
      oidcAdminGroups: o.adminGroups,
      oidcLinkByEmail: o.linkByEmail,
      forwardAuthEnabled: f.enabled,
      forwardAuthUserHeader: f.userHeader,
      forwardAuthEmailHeader: f.emailHeader,
      forwardAuthNameHeader: f.nameHeader,
      forwardAuthGroupsHeader: f.groupsHeader,
      forwardAuthTrustedProxies: f.trustedProxies,
      forwardAuthAllowedGroups: f.allowedGroups,
      forwardAuthAdminGroups: f.adminGroups,
      updatedBy: by,
    };
    const saved = await this.prisma.authSettings.update({ where: { id: 1 }, data });
    this.invalidate();
    this.log.log(`SSO settings updated by ${by}`);
    return this.toWire(saved);
  }

  /** OIDC discovery against `issuer` (default: the saved one) without saving anything. */
  async test(issuer?: string): Promise<{ ok: boolean; issuer?: string; error?: string }> {
    const r = await this.row();
    const target = issuer?.trim() || r.oidcIssuer;
    if (!target) return { ok: false, error: 'no issuer configured' };
    try {
      const config = await discoverOidc({ issuer: target, clientId: r.oidcClientId ?? 'synclet', clientSecret: null }, this.config.ssoAllowHttpIssuer);
      return { ok: true, issuer: config.serverMetadata().issuer };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    }
  }
}

export function errorMessage(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string } };
  const msg = err?.message ?? String(e);
  return err?.cause?.message ? `${msg} (${err.cause.message})` : msg;
}
