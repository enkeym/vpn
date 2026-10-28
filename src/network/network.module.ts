import { Global, Module } from '@nestjs/common';
import { DnsSyncService } from './dns-sync.service';
import { HostNetworkService } from './host-network.service';
import { StartupReportService } from './startup-report.service';

@Global()
@Module({
  providers: [HostNetworkService, DnsSyncService, StartupReportService],
  exports: [HostNetworkService],
})
export class NetworkModule {}
