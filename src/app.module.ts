import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { XrayModule } from './xray/xray.module';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { PeersModule } from './peers/peers.module';
import { DatabaseModule } from './database/database.module';
import { BotModule } from './bot/bot.module';
import { NotificationModule } from './notification/notification.module';
import { CacheModule } from './common/cache/cache.module';
import { PaymentModule } from './payment/payment.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { SecurityModule } from './security/security.module';
import { InternalGuard } from './common/guards/internal.guard';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
    CacheModule,
    NotificationModule,
    DatabaseModule,
    XrayModule,
    PeersModule,
    BotModule,
    PaymentModule,
    SubscriptionModule,
    SecurityModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    InternalGuard,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
