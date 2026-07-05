import { Module } from '@nestjs/common';
import { HysteriaService } from './hysteria.service';

@Module({
  providers: [HysteriaService],
  exports: [HysteriaService],
})
export class HysteriaModule {}
