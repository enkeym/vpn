import { Module } from '@nestjs/common';
import { BlockedUsersService } from './blocked.service';
import { DatabaseModule } from 'src/database/database.module';

@Module({
  imports: [DatabaseModule],
  providers: [BlockedUsersService],
  exports: [BlockedUsersService],
})
export class BlockedModule {}
