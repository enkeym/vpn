import { Module, forwardRef } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentFulfillmentService } from './payment-fulfillment.service';
import { AutopayService } from './autopay.service';
import { PaymentController } from './payment.controller';
import { PeersModule } from '../peers/peers.module';
import { BotModule } from '../bot/bot.module';
import { DatabaseModule } from '../database/database.module';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [
    DatabaseModule,
    PeersModule,
    SettingsModule,
    forwardRef(() => BotModule),
  ],
  providers: [PaymentService, PaymentFulfillmentService, AutopayService],
  controllers: [PaymentController],
  exports: [PaymentService, PaymentFulfillmentService, AutopayService],
})
export class PaymentModule {}
