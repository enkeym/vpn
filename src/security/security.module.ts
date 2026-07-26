import { Module } from '@nestjs/common';
import { DeviceLimitService } from './device-limit.service';
import { XrayModule } from 'src/xray/xray.module';
import { NotificationModule } from 'src/notification/notification.module';

@Module({
  imports: [XrayModule, NotificationModule],
  providers: [DeviceLimitService],
  exports: [DeviceLimitService],
})
export class SecurityModule {}
