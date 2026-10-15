import { Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ServerConfigService {
  private cached?: { serverId: string; jwtSecret: string };
  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<{ serverId: string; jwtSecret: string }> {
    if (this.cached) return this.cached;
    const row = await this.prisma.serverConfig.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, serverId: randomUUID(), jwtSecret: randomBytes(48).toString('base64url') },
    });
    this.cached = { serverId: row.serverId, jwtSecret: row.jwtSecret };
    return this.cached;
  }
}
