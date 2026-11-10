import { Module } from '@nestjs/common';
import { HysteriaService } from './hysteria.service';

@Module({
  imports: [],
  controllers: [],
  providers: [HysteriaService],
  exports: [HysteriaService],
})
export class HysteriaModule {}
