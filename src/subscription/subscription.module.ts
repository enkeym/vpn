import { Module } from '@nestjs/common';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { PeersModule } from 'src/peers/peers.module';
import { XrayModule } from 'src/xray/xray.module';

@Module({
  imports: [PeersModule, XrayModule],
  controllers: [SubscriptionController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
