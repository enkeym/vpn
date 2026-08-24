import { Module } from '@nestjs/common';
import { XrayService } from './xray.service';

@Module({
  imports: [],
  controllers: [],
  providers: [XrayService],
  exports: [XrayService],
})
export class XrayModule {}
