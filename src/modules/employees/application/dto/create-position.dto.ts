import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreatePositionDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
