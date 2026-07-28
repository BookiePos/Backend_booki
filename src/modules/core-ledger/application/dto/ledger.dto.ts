import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { ACCOUNT_TYPES, AccountType } from '../../domain/ledger.constants';

export class CreateAccountDto {
  @IsString()
  @Matches(/^\d{3,6}$/, { message: 'El código de cuenta debe tener 3 a 6 dígitos' })
  code!: string;

  @IsString()
  name!: string;

  @IsIn(ACCOUNT_TYPES)
  type!: AccountType;
}

export class JournalLineDto {
  @IsString()
  accountCode!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  debit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  credit?: number;

  @IsOptional()
  @IsMongoId()
  sedeId?: string;

  @IsOptional()
  @IsString()
  memo?: string;
}

export class CreateJournalEntryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date debe ser YYYY-MM-DD' })
  date!: string;

  @IsOptional()
  @IsString()
  sourceType?: string;

  @IsOptional()
  @IsString()
  sourceId?: string;

  @IsOptional()
  @IsString()
  memo?: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => JournalLineDto)
  lines!: JournalLineDto[];
}
