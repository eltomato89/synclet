import { Global, Module } from '@nestjs/common';
import { JournalModule } from '../journal/journal.module';
import { DiscoveryService } from './discovery.service';
import { SpaceAccess } from './space-access.service';
import { SpacesRepo } from './spaces.repo';

@Global()
@Module({
  imports: [JournalModule],
  providers: [SpacesRepo, SpaceAccess, DiscoveryService],
  exports: [SpacesRepo, SpaceAccess, DiscoveryService],
})
export class SpacesModule {}
