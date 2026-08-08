import { Module } from '@nestjs/common';
import { AwgService } from './awg.service';

@Module({
  imports: [],
  controllers: [],
  providers: [AwgService],
  exports: [AwgService],
})
export class WgModule {}
