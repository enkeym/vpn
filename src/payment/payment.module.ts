import { Module, forwardRef } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { PeersModule } from '../peers/peers.module';
import { BotModule } from '../bot/bot.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule, PeersModule, forwardRef(() => BotModule)],
  providers: [PaymentService],
  controllers: [PaymentController],
  exports: [PaymentService],
})
export class PaymentModule {}
