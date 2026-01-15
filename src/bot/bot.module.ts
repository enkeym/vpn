import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';
import { PeersModule } from 'src/peers/peers.module';

@Module({
  imports: [PeersModule],
  providers: [BotService],
  controllers: [BotController],
})
export class BotModule {}
