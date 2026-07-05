import { Module } from '@nestjs/common';
import { PeersController } from './peers.controller';
import { PeersService } from './peers.service';
import { PeersSchedulerService } from './peers-scheduler.service';
import { WgModule } from 'src/wg/wg.module';
import { XrayModule } from 'src/xray/xray.module';
import { HysteriaModule } from 'src/hysteria/hysteria.module';

@Module({
  imports: [WgModule, XrayModule, HysteriaModule],
  controllers: [PeersController],
  providers: [PeersService, PeersSchedulerService],
  exports: [PeersService],
})
export class PeersModule {}
