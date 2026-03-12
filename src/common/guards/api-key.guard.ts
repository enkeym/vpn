import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const apiKey = request.headers['x-api-key'];
    const expectedKey = this.configService.get<string>('PEERS_API_KEY');

    if (!expectedKey) {
      throw new UnauthorizedException('API not configured');
    }

    const apiKeyStr = typeof apiKey === 'string' ? apiKey : '';
    const expectedBuf = Buffer.from(expectedKey, 'utf8');
    const actualBuf = Buffer.from(apiKeyStr, 'utf8');

    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
