import { Module } from '@nestjs/common';
import { WgService } from './wg.service';
import { WgController } from './wg.controller';

@Module({
  imports: [],
  controllers: [WgController],
  providers: [WgService],
  exports: [WgService],
})
export class WgModule {}
