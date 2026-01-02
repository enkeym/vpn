import { Body, Controller, Post } from '@nestjs/common';
import { WgService } from './wg.service';

@Controller('peer')
export class WgController {
  constructor(private readonly wgService: WgService) {}

  @Post()
  async createConfig(@Body('name') name: string) {
    await this.wgService.createClientConfig(name);
  }
}
