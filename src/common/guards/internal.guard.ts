import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

@Injectable()
export class InternalGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = (request.ip || request.socket?.remoteAddress || '').trim();
    const internalKey = this.configService.get<string>('INTERNAL_METRICS_KEY');

    if (LOCALHOST_IPS.has(ip)) {
      return true;
    }

    const key = typeof internalKey === 'string' ? internalKey.trim() : '';
    if (!key) {
      throw new ForbiddenException('Access denied');
    }

    const headerKey = request.headers['x-internal-key'];
    const headerStr = typeof headerKey === 'string' ? headerKey.trim() : '';
    if (!headerStr) {
      throw new ForbiddenException('Access denied');
    }
    const expectedBuf = Buffer.from(key, 'utf8');
    const actualBuf = Buffer.from(headerStr, 'utf8');

    if (
      expectedBuf.length === actualBuf.length &&
      timingSafeEqual(expectedBuf, actualBuf)
    ) {
      return true;
    }

    throw new ForbiddenException('Access denied');
  }
}
