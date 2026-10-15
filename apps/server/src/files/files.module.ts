import { Module } from '@nestjs/common';
import { VersionsService } from '../versions/versions.service';
import { FilesService } from './files.service';

// VersionsService: Task 3 stub until the versions module (Task 2) is merged.
@Module({ providers: [FilesService, VersionsService], exports: [FilesService, VersionsService] })
export class FilesModule {}
