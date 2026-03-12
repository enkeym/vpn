import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { CreatePeerDto } from './dto/create-peer.dto';
import { PeersService } from './peers.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

@Controller('peers')
@UseGuards(ApiKeyGuard)
export class PeersController {
  constructor(private readonly peersService: PeersService) {}

  @Post()
  async create(@Body() createPeerDto: CreatePeerDto) {
    return this.peersService.createPeer(createPeerDto);
  }

  @Get()
  async findAll() {
    const peers = await this.peersService.allPeers();
    return peers.map((p) => this.sanitizePeer(p));
  }

  @Get(':name')
  async findOne(@Param('name') name: string) {
    const peer = await this.peersService.findPeer(name);
    return this.sanitizePeer(peer);
  }

  @Put(':name')
  async update(@Param('name') name: string) {
    await this.peersService.updatedPeer(name);
    const peer = await this.peersService.findPeer(name);
    return this.sanitizePeer(peer);
  }

  @Delete(':name')
  async remove(@Param('name') name: string) {
    return this.peersService.deletePeer(name);
  }

  private sanitizePeer(peer: Record<string, unknown>) {
    const { privateKey, presharedKey, ...safe } = peer;
    return safe;
  }
}
