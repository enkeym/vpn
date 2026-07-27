import { Module } from '@nestjs/common';
import { WgService } from './wg.service';
import { AwgService } from './awg.service';
import { TunnelRegistry } from './tunnel.registry';

@Module({
  imports: [],
  controllers: [],
  providers: [WgService, AwgService, TunnelRegistry],
  exports: [WgService, AwgService, TunnelRegistry],
})
export class WgModule {}
