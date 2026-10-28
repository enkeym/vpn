import { Global, Module } from '@nestjs/common';
import { DnsSyncService } from './dns-sync.service';
import { HostNetworkService } from './host-network.service';

@Global()
@Module({
  providers: [HostNetworkService, DnsSyncService],
  exports: [HostNetworkService],
})
export class NetworkModule {}
