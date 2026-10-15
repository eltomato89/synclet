import { PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';
import { SyncError } from './sync-error';

export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) throw new SyncError('invalid_request', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return r.data;
  }
}
