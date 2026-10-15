import { Global, Module } from '@nestjs/common';
import { BusyPaths } from './busy-paths';
import { ItemStore } from './item-store';
import { JournalService } from './journal.service';

@Global()
@Module({ providers: [JournalService, ItemStore, BusyPaths], exports: [JournalService, ItemStore, BusyPaths] })
export class JournalModule {}
