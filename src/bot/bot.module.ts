import { Module, forwardRef } from '@nestjs/common';
import { BotService } from './bot.service';
import { PeersModule } from 'src/peers/peers.module';
import { FamilyModule } from 'src/family/family.module';
import { BlockedModule } from 'src/blocked/blocked.module';
import { MainHandler } from './handlers/main.handler';
import { PeerCreateHandler } from './handlers/peer-create.handler';
import { PeerManageHandler } from './handlers/peer-manage.handler';
import { PeerDeleteHandler } from './handlers/peer-delete.handler';
import { FamilyHandler } from './handlers/family.handler';
import { AdminHandler } from './handlers/admin.handler';
import { AutopayHandler } from './handlers/autopay.handler';
import { PaymentModule } from 'src/payment/payment.module';
import { InvoiceService } from './invoice/invoice.service';
import { MainMenuService } from './menu/main-menu.service';
import { MainMenuAnchorStore } from './menu/main-menu-anchor.store';
import { UserCommandsRegistrar } from './registrars/user-commands.registrar';
import { FamilyCommandsRegistrar } from './registrars/family-commands.registrar';
import { AdminCommandsRegistrar } from './registrars/admin-commands.registrar';

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
    AutopayHandler,
    InvoiceService,
    MainMenuService,
    MainMenuAnchorStore,
    UserCommandsRegistrar,
    FamilyCommandsRegistrar,
    AdminCommandsRegistrar,
  ],
  controllers: [],
  exports: [BotService],
})
export class BotModule {}
