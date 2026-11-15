import { Module } from '@nestjs/common';
import { SubscriptionController } from './subscription.controller';
import { SubscriptionService } from './subscription.service';
import { PeersModule } from 'src/peers/peers.module';
import { XrayModule } from 'src/xray/xray.module';
import { HysteriaModule } from 'src/hysteria/hysteria.module';
import { ShadowsocksModule } from 'src/shadowsocks/shadowsocks.module';

@Module({
  imports: [PeersModule, XrayModule, HysteriaModule, ShadowsocksModule],
  controllers: [SubscriptionController],
  providers: [SubscriptionService],
  exports: [SubscriptionService],
})
export class SubscriptionModule {}
