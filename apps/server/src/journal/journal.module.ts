import { Global, Module } from '@nestjs/common';
import { ItemStore } from './item-store';
import { JournalService } from './journal.service';

@Global()
@Module({ providers: [JournalService, ItemStore], exports: [JournalService, ItemStore] })
export class JournalModule {}
