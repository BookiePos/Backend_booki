import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  BUDGET_SCENARIOS,
  BudgetScenario,
  BUDGET_STATUSES,
  BudgetStatus,
  CATEGORY_KINDS,
  CategoryKind,
} from '../../domain/finance.constants';

/** Línea de presupuesto (12 montos mensuales). */
export class BudgetLineDto {
  @IsMongoId()
  categoryId!: string;

  @IsString()
  @MaxLength(120)
  categoryName!: string;

  @IsIn(CATEGORY_KINDS as readonly string[])
  kind!: CategoryKind;

  @IsArray()
  @ArrayMinSize(12)
  @ArrayMaxSize(12)
  @IsNumber({}, { each: true })
  monthly!: number[];
}

/** Crea un presupuesto anual. `sedeId` opcional (null = consolidado). */
export class CreateBudgetDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsInt()
  fiscalYear!: number;

  @IsOptional()
  @IsMongoId()
  sedeId?: string;

  @IsOptional()
  @IsIn(BUDGET_SCENARIOS as readonly string[])
  scenario?: BudgetScenario;

  @IsOptional()
  @IsIn(BUDGET_STATUSES as readonly string[])
  status?: BudgetStatus;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BudgetLineDto)
  lines?: BudgetLineDto[];
}

/** Actualiza un presupuesto (merge parcial). */
export class UpdateBudgetDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsIn(BUDGET_SCENARIOS as readonly string[])
  scenario?: BudgetScenario;

  @IsOptional()
  @IsIn(BUDGET_STATUSES as readonly string[])
  status?: BudgetStatus;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BudgetLineDto)
  lines?: BudgetLineDto[];
}
