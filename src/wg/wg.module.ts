import { Module } from '@nestjs/common';
import { WgService } from './wg.service';

@Module({
  imports: [],
  controllers: [],
  providers: [WgService],
  exports: [WgService],
})
export class WgModule {}
