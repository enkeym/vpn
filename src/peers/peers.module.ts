import { Module } from '@nestjs/common';
import { PeersController } from './peers.controller';
import { PeersService } from './peers.service';
import { WgModule } from 'src/wg/wg.module';

@Module({
  imports: [WgModule],
  controllers: [PeersController],
  providers: [PeersService],
  exports: [PeersService],
})
export class PeersModule {}
