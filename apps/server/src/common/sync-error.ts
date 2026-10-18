import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Item } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import type { SyncErrorCode } from '@synclet/shared';

const STATUS: Record<SyncErrorCode, number> = {
  unauthorized: 401, device_revoked: 401, forbidden: 403, not_found: 404, name_conflict: 409,
  invalid_move: 400, invalid_name: 400, invalid_request: 400, cursor_expired: 410, conflict: 412,
  precondition_required: 428, too_large: 413, range_not_satisfiable: 416, setup_done: 409,
  share_password_required: 401, share_expired: 410, rate_limited: 429, upload_not_allowed: 403,
  office_disabled: 503, sso_not_allowed: 403, password_login_disabled: 403, insufficient_storage: 507,
  space_unavailable: 503, invalid_target: 400,
};

export class SyncError extends Error {
  readonly status: number;
  /** `status` overrides the code's default HTTP status (e.g. 409 for a trash `conflict`). */
  constructor(readonly code: SyncErrorCode, message?: string, readonly itemRow?: Item, status?: number) {
    super(message ?? code);
    this.status = status ?? STATUS[code];
  }
}

@Catch(SyncError)
export class SyncErrorFilter implements ExceptionFilter {
  /** Installed by SyncModule so error bodies can carry a serialized SyncItem. */
  static serializeItem?: (row: Item, user?: { id: string }) => Promise<unknown>;

  async catch(err: SyncError, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const user = host.switchToHttp().getRequest<{ user?: { id: string } }>()?.user;
    const body: Record<string, unknown> = { statusCode: err.status, message: err.message, code: err.code };
    if (err.itemRow && SyncErrorFilter.serializeItem) body.item = await SyncErrorFilter.serializeItem(err.itemRow, user);
    await reply.status(err.status).send(body);
  }
}
