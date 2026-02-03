import { Module } from '@nestjs/common';
import { FamilyService } from './family.service';

@Module({
  providers: [FamilyService],
  exports: [FamilyService],
})
export class FamilyModule {}
