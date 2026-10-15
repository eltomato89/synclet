import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import * as argon2 from 'argon2';
import { z } from 'zod';
import { SyncError } from '../common/sync-error';
import { ZodPipe } from '../common/zod.pipe';
import { PrismaService } from '../prisma/prisma.service';
import { AuthGuard } from './auth.guard';
import { AdminOnly } from './current-user.decorator';
import { UsersService } from './users.service';

const CreateBody = z.object({
  username: z.string(), displayName: z.string().min(1).max(100), email: z.string().email().nullish(),
  password: z.string().min(10).max(200), role: z.enum(['admin', 'user']).default('user'),
});
const PatchBody = z.object({ disabled: z.boolean().optional(), password: z.string().min(10).max(200).optional(), displayName: z.string().min(1).max(100).optional() });

@Controller('admin/users')
@UseGuards(AuthGuard)
@AdminOnly()
export class AdminUsersController {
  constructor(private readonly prisma: PrismaService, private readonly users: UsersService) {}

  @Get()
  async list() {
    return (await this.prisma.user.findMany({ orderBy: { createdAt: 'asc' } })).map((u) => ({ ...this.users.toPublic(u), disabled: u.disabledAt !== null }));
  }

  @Post()
  @HttpCode(201)
  async create(@Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>) {
    return this.users.toPublic(await this.users.create(body));
  }

  @Patch(':id')
  async patch(@Param('id') id: string, @Body(new ZodPipe(PatchBody)) body: z.infer<typeof PatchBody>) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new SyncError('not_found');
    if (body.password) {
      const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
      await this.prisma.identity.updateMany({ where: { userId: id, provider: 'local' }, data: { passwordHash } });
    }
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.disabled !== undefined ? { disabledAt: body.disabled ? new Date() : null } : {}),
      },
    });
    if (body.disabled) {
      await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    return { ...this.users.toPublic(updated), disabled: updated.disabledAt !== null };
  }
}
