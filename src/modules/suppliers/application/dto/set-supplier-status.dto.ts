import { IsBoolean } from 'class-validator';

export class SetSupplierStatusDto {
  @IsBoolean()
  active!: boolean;
}
