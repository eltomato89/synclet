import { Module } from '@nestjs/common';
import { VersionsModule } from '../versions/versions.module';
import { FilesService } from './files.service';

/** Re-exports VersionsModule: FilesService captures versions before every overwrite. */
@Module({ imports: [VersionsModule], providers: [FilesService], exports: [FilesService, VersionsModule] })
export class FilesModule {}
