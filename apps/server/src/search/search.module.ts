import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SyncModule } from '../sync/sync.module';
import { SearchController } from './search.controller';
import { SearchLanguage } from './search-language';
import { SearchService } from './search.service';

@Module({
  imports: [AuthModule, SyncModule],
  controllers: [SearchController],
  providers: [SearchLanguage, SearchService],
})
export class SearchModule {}
