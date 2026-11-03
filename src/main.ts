import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get(ConfigService);

  const httpAdapter = app.get(HttpAdapterHost);
  app.useGlobalFilters(new AllExceptionsFilter(httpAdapter));
  // Доверяем ровно одному прокси-хопу (nginx/caddy перед приложением). При
  // `true` Express доверял бы любому X-Forwarded-For, и req.ip подделывался бы
  // напрямую — тогда IP-allow-list вебхука ЮKassa обходится. Число хопов
  // настраивается через TRUST_PROXY_HOPS (по умолчанию 1).
  app.set('trust proxy', Number(config.get<string>('TRUST_PROXY_HOPS', '1')));

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

  await app.listen(
    Number(config.get<string>('PORT', '3000')),
    config.get<string>('HTTP_HOST', '127.0.0.1'),
  );
}
void bootstrap();
