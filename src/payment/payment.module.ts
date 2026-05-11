import { Module, forwardRef } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentFulfillmentService } from './payment-fulfillment.service';
import { PaymentController } from './payment.controller';
import { PeersModule } from '../peers/peers.module';
import { BotModule } from '../bot/bot.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule, PeersModule, forwardRef(() => BotModule)],
  providers: [PaymentService, PaymentFulfillmentService],
  controllers: [PaymentController],
  exports: [PaymentService, PaymentFulfillmentService],
})
export class PaymentModule {}
