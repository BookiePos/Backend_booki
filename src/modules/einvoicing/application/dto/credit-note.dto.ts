import { IsString, MinLength } from 'class-validator';

export class CreditNoteDto {
  @IsString()
  @MinLength(3)
  reason!: string;
}
