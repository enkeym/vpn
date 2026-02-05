import { Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';
import { PeersModule } from 'src/peers/peers.module';
import { FamilyModule } from 'src/family/family.module';
import { MainHandler } from './handlers/main.handler';
import { PeerCreateHandler } from './handlers/peer-create.handler';
import { PeerManageHandler } from './handlers/peer-manage.handler';
import { PeerDeleteHandler } from './handlers/peer-delete.handler';
import { FamilyHandler } from './handlers/family.handler';
import { AdminHandler } from './handlers/admin.handler';

@Module({
  imports: [PeersModule, FamilyModule],
  providers: [
    BotService,
    MainHandler,
    PeerCreateHandler,
    PeerDeleteHandler,
    PeerManageHandler,
    FamilyHandler,
    AdminHandler,
  ],
  controllers: [BotController],
})
export class BotModule {}
