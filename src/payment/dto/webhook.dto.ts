import { IsString, IsOptional, ValidateNested, IsIn } from 'class-validator';
import { Type } from 'class-transformer';

class YooKassaWebhookObjectDto {
  @IsString()
  id!: string;

  @IsOptional()
  @IsString()
  status?: string;
}

export class YooKassaWebhookDto {
  @IsString()
  event!: string;

  @ValidateNested()
  @Type(() => YooKassaWebhookObjectDto)
  object!: YooKassaWebhookObjectDto;
}
