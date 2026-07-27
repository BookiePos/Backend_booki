import { Type } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  ACCOUNT_TYPES,
  ARL_RISK_LEVELS,
  CONTRACT_TYPES,
  DOC_STATUS,
  EMP_DOC_TYPES,
  EMPLOYEE_STATUS,
  GENDERS,
  SALARY_TYPES,
  YYYYMMDD,
} from '../../domain/employees.constants';

/** Documento/certificado del expediente (checklist legal). */
export class LegalDocumentDto {
  @IsString()
  @MinLength(1)
  type!: string;

  @IsOptional()
  @IsString()
  number?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @Matches(YYYYMMDD, { message: 'issueDate debe ser YYYY-MM-DD' })
  issueDate?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @Matches(YYYYMMDD, { message: 'expiryDate debe ser YYYY-MM-DD' })
  expiryDate?: string;

  @IsOptional()
  @IsIn(DOC_STATUS as readonly string[])
  status?: string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateEmployeeDto {
  // Identificación
  @IsOptional()
  @IsIn(EMP_DOC_TYPES as readonly string[])
  docType?: string;

  @IsString()
  @MinLength(1)
  docNumber!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @Matches(YYYYMMDD, { message: 'birthDate debe ser YYYY-MM-DD' })
  birthDate?: string;

  @IsOptional()
  @IsIn(GENDERS as readonly string[])
  gender?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  emergencyContactName?: string;

  @IsOptional()
  @IsString()
  emergencyContactPhone?: string;

  // Contratación
  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v != null)
  @IsMongoId()
  positionId?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '' && v != null)
  @IsMongoId()
  sedeId?: string;

  @IsOptional()
  @IsIn(CONTRACT_TYPES as readonly string[])
  contractType?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @Matches(YYYYMMDD, { message: 'hireDate debe ser YYYY-MM-DD' })
  hireDate?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @Matches(YYYYMMDD, { message: 'endDate debe ser YYYY-MM-DD' })
  endDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  salary?: number;

  @IsOptional()
  @IsIn(SALARY_TYPES as readonly string[])
  salaryType?: string;

  @IsOptional()
  @IsString()
  workSchedule?: string;

  // Seguridad social
  @IsOptional()
  @IsString()
  eps?: string;

  @IsOptional()
  @IsString()
  afp?: string;

  @IsOptional()
  @IsString()
  arl?: string;

  @IsOptional()
  @IsIn(ARL_RISK_LEVELS as readonly string[])
  arlRiskLevel?: string;

  @IsOptional()
  @IsString()
  compensationFund?: string;

  @IsOptional()
  @IsString()
  severanceFund?: string;

  // Bancario
  @IsOptional()
  @IsString()
  bank?: string;

  @IsOptional()
  @IsIn(ACCOUNT_TYPES as readonly string[])
  accountType?: string;

  @IsOptional()
  @IsString()
  accountNumber?: string;

  // Documentos / certificados
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LegalDocumentDto)
  documents?: LegalDocumentDto[];

  // Estado / vínculo
  @IsOptional()
  @IsIn(EMPLOYEE_STATUS as readonly string[])
  status?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== '')
  @Matches(YYYYMMDD, { message: 'terminationDate debe ser YYYY-MM-DD' })
  terminationDate?: string;

  @IsOptional()
  @IsString()
  terminationReason?: string;

  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
