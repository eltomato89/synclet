import { Logger, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { APP_CONFIG, AppConfig } from '../config';
import { ChangeNotifier } from './change-notifier';
import { EventsController } from './events.controller';
import { listenClientFactory, usesTransactionPooler } from './pg-listen-client';

/** SSE change events (`GET /api/sync/v1/events`). Server role only; the worker never imports it. */
@Module({
  imports: [AuthModule],
  controllers: [EventsController],
  providers: [
    {
      provide: ChangeNotifier,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => {
        const url = process.env.DATABASE_URL ?? '';
        if (config.role === 'server' && url && usesTransactionPooler(url)) {
          new Logger('ChangeNotifier').warn('DATABASE_URL uses pgbouncer=true: a transaction-pooling connection never delivers notifications; '
            + 'event streams fall back to the check before each ping (README, "PostgreSQL").');
        }
        return new ChangeNotifier({ enabled: config.role === 'server', createClient: listenClientFactory(url) });
      },
    },
  ],
  exports: [ChangeNotifier],
})
export class EventsModule {}
