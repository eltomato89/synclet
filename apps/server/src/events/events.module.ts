import { Module } from '@nestjs/common';
import { Client } from 'pg';
import { AuthModule } from '../auth/auth.module';
import { APP_CONFIG, AppConfig } from '../config';
import { ChangeNotifier } from './change-notifier';
import { EventsController } from './events.controller';

/** SSE change events (`GET /api/sync/v1/events`). Server role only; the worker never imports it. */
@Module({
  imports: [AuthModule],
  controllers: [EventsController],
  providers: [
    {
      provide: ChangeNotifier,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new ChangeNotifier({
        enabled: config.role === 'server',
        createClient: () => new Client({ connectionString: process.env.DATABASE_URL, keepAlive: true }),
      }),
    },
  ],
  exports: [ChangeNotifier],
})
export class EventsModule {}
