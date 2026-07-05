import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as http from 'http';
import * as https from 'https';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const httpAdapter = app.get(HttpAdapterHost);
  app.useGlobalFilters(new AllExceptionsFilter(httpAdapter));
  app.set('trust proxy', true);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Telegram bot — нет веб-фронтенда, CORS не требуется
  // Telegram bot — веб-фронтенда нет, CORS отключён
  app.enableCors({ origin: false });

  await app.init();
  const expressInstance = app.getHttpAdapter().getInstance();

  http.createServer(expressInstance).listen(process.env.PORT ?? 3000);

  // Подписка (src/subscription) отдаётся через Cloudflare на отдельном порту.
  // Зона в режиме Full (strict) — Cloudflare требует TLS от origin даже здесь,
  // поэтому поднимаем HTTPS тем же сертификатом Cloudflare Origin CA, что и Xray.
  const certPath = path.join(process.cwd(), 'configs', 'cloudflare-cert.pem');
  const keyPath = path.join(process.cwd(), 'configs', 'cloudflare-key.pem');

  if (existsSync(certPath) && existsSync(keyPath)) {
    https
      .createServer(
        { cert: readFileSync(certPath), key: readFileSync(keyPath) },
        expressInstance,
      )
      .listen(process.env.SUB_INTERNAL_PORT ?? 3443);
  }
}
void bootstrap();
