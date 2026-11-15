import { Module } from '@nestjs/common';
import { ShadowsocksService } from './shadowsocks.service';

@Module({
  imports: [],
  controllers: [],
  providers: [ShadowsocksService],
  exports: [ShadowsocksService],
})
export class ShadowsocksModule {}
