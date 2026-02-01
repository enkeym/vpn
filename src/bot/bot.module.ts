import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';
import { PeersModule } from 'src/peers/peers.module';
import { MainHandler } from './handlers/main.handler';
import { PeerCreateHandler } from './handlers/peer-create.handler';
import { PeerManageHandler } from './handlers/peer-manage.handler';
import { PeerDeleteHandler } from './handlers/peer-delete.handler';

@Module({
  imports: [PeersModule],
  providers: [
    BotService,
    MainHandler,
    PeerCreateHandler,
    PeerDeleteHandler,
    PeerManageHandler,
  ],
  controllers: [BotController],
})
export class BotModule {}
