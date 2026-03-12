import { Module, forwardRef } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';
import { PeersModule } from 'src/peers/peers.module';
import { FamilyModule } from 'src/family/family.module';
import { BlockedModule } from 'src/blocked/blocked.module';
import { MainHandler } from './handlers/main.handler';
import { PeerCreateHandler } from './handlers/peer-create.handler';
import { PeerManageHandler } from './handlers/peer-manage.handler';
import { PeerDeleteHandler } from './handlers/peer-delete.handler';
import { FamilyHandler } from './handlers/family.handler';
import { AdminHandler } from './handlers/admin.handler';
import { PaymentModule } from 'src/payment/payment.module';

@Module({
  imports: [
    PeersModule,
    FamilyModule,
    BlockedModule,
    forwardRef(() => PaymentModule),
  ],
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
  exports: [BotService],
})
export class BotModule {}
