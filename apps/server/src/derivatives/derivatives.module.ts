import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { DerivativesGc } from './derivatives-gc';
import { DerivedStore } from './derived-store';

/** Derivative store access shared by the server (thumbnail route, GC) and the worker. */
@Module({
  providers: [
    { provide: DerivedStore, useFactory: (c: AppConfig) => new DerivedStore(c.metaRoot), inject: [APP_CONFIG] },
    DerivativesGc,
  ],
  exports: [DerivedStore, DerivativesGc],
})
export class DerivativesModule {}
