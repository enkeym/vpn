import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { NestExpressApplication } from '@nestjs/platform-express';

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

  // Обычный HTTP — внешний TLS терминирует nginx (docker/nginx.conf),
  // который проксирует сюда /sub и остальные NestJS-пути.
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
