import { Global, Module } from '@nestjs/common';
import { DnsSyncService } from './dns-sync.service';
import { HostNetworkService } from './host-network.service';
import { ReachabilityService } from './reachability.service';
import { StartupReportService } from './startup-report.service';

@Global()
@Module({
  providers: [
    HostNetworkService,
    DnsSyncService,
    StartupReportService,
    ReachabilityService,
  ],
  exports: [HostNetworkService, ReachabilityService],
})
export class NetworkModule {}
