import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config';
import { DerivativesGc } from './derivatives-gc';
import { DerivedStore } from './derived-store';
import { FolderThumbnails } from './folder-thumbnails';

/** Derivative store access shared by the server (thumbnail routes, folder mosaics, GC) and the worker. */
@Module({
  providers: [
    { provide: DerivedStore, useFactory: (c: AppConfig) => new DerivedStore(c.metaRoot), inject: [APP_CONFIG] },
    DerivativesGc,
    FolderThumbnails,
  ],
  exports: [DerivedStore, DerivativesGc, FolderThumbnails],
})
export class DerivativesModule {}
