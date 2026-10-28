import { Global, Module } from '@nestjs/common';
import { HostNetworkService } from './host-network.service';

@Global()
@Module({
  providers: [HostNetworkService],
  exports: [HostNetworkService],
})
export class NetworkModule {}
