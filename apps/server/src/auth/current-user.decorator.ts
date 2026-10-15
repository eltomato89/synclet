import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthUser } from '../common/types';

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);
export const ADMIN_ONLY = 'synclet:adminOnly';
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);
export const ALLOW_DT = 'synclet:allowDownloadToken';
/** Route also accepts `?dt=<download token>` bound to `params.id`. */
export const AllowDownloadToken = () => SetMetadata(ALLOW_DT, true);
