import { Module } from '@nestjs/common';
import { PeersController } from './peers.controller';
import { PeersService } from './peers.service';
import { PeersSchedulerService } from './peers-scheduler.service';
import { XrayModule } from 'src/xray/xray.module';

@Module({
  imports: [XrayModule],
  controllers: [PeersController],
  providers: [PeersService, PeersSchedulerService],
  exports: [PeersService],
})
export class PeersModule {}
