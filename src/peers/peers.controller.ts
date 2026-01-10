import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import type { ICreatePeer } from './dto/create-peer.dto';
import { PeersService } from './peers.service';

@Controller('peers')
export class PeersController {
  constructor(private readonly peersService: PeersService) {}

  @Post()
  async create(@Body() createPeerDto: ICreatePeer) {
    return this.peersService.createPeer(createPeerDto);
  }

  @Get()
  async findAll() {
    return this.peersService.allPeers();
  }

  @Get(':name')
  async findOne(@Param('name') name: string) {
    return this.peersService.findPeer(name);
  }

  @Put(':name')
  async update(@Param('name') name: string) {
    await this.peersService.updatedPeer(name);

    return this.peersService.findPeer(name);
  }

  @Delete(':name')
  async remove(@Param('name') name: string) {
    return this.peersService.deletePeer(name);
  }
}
