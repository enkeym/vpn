import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { WgModule } from './wg/wg.module';
import { ConfigModule } from '@nestjs/config';
import { PeersModule } from './peers/peers.module';
import { DatabaseModule } from './database/database.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    WgModule,
    PeersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
