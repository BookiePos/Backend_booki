import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import {
  ACCOUNT_TYPES,
  AccountType,
  ARL_RISK_LEVELS,
  ArlRiskLevel,
  CONTRACT_TYPES,
  ContractType,
  DOC_STATUS,
  DocStatus,
  EMP_DOC_TYPES,
  EMPLOYEE_STATUS,
  EmpDocType,
  EmployeeStatus,
  GENDERS,
  Gender,
  SALARY_TYPES,
  SalaryType,
} from '../../domain/employees.constants';

export type EmployeeDocument = HydratedDocument<Employee>;

/**
 * Documento/certificado del expediente del empleado (checklist legal): contrato,
 * exámenes médicos, antecedentes, afiliaciones EPS/ARL, etc. Sin archivo por
 * ahora: se lleva el control con tipo, número, vigencia y estado.
 */
@Schema({ _id: false })
export class LegalDocument {
  /** Tipo/nombre del documento (ej. "Contrato de trabajo", "Examen médico"). */
  @Prop({ required: true, trim: true })
  type!: string;

  @Prop({ trim: true })
  number?: string;

  /** Fecha de emisión (YYYY-MM-DD). */
  @Prop({ trim: true })
  issueDate?: string;

  /** Fecha de vencimiento (YYYY-MM-DD). */
  @Prop({ trim: true })
  expiryDate?: string;

  @Prop({ enum: DOC_STATUS, default: 'pendiente' })
  status!: DocStatus;

  @Prop({ trim: true })
  note?: string;
}
const LegalDocumentSchema = SchemaFactory.createForClass(LegalDocument);

/**
 * Empleado del negocio (expediente de RRHH). Registro independiente de los
 * usuarios del sistema: cubre también a quienes no tienen login. Opcionalmente
 * se vincula a un usuario (`userId`) para nómina/POS.
 */
@Schema({ timestamps: true, collection: 'employees' })
export class Employee {
  // ── Identificación ─────────────────────────────────────────────────────────
  @Prop({ required: true, enum: EMP_DOC_TYPES, default: 'CC' })
  docType!: EmpDocType;

  @Prop({ required: true, trim: true })
  docNumber!: string;

  @Prop({ required: true, trim: true })
  firstName!: string;

  @Prop({ required: true, trim: true })
  lastName!: string;

  /** Fecha de nacimiento (YYYY-MM-DD). */
  @Prop({ trim: true })
  birthDate?: string;

  @Prop({ enum: GENDERS })
  gender?: Gender;

  @Prop({ trim: true })
  phone?: string;

  @Prop({ trim: true })
  email?: string;

  @Prop({ trim: true })
  address?: string;

  @Prop({ trim: true })
  city?: string;

  @Prop({ trim: true })
  emergencyContactName?: string;

  @Prop({ trim: true })
  emergencyContactPhone?: string;

  // ── Contratación ─────────────────────────────────────────────────────────────
  @Prop({ type: Types.ObjectId, ref: 'Position' })
  positionId?: Types.ObjectId;

  /** Snapshot del nombre del cargo (para listar sin populate). */
  @Prop({ trim: true })
  positionName?: string;

  /** Sede a la que está asignado (opcional). */
  @Prop({ type: Types.ObjectId, ref: 'Sede' })
  sedeId?: Types.ObjectId;

  @Prop({ enum: CONTRACT_TYPES, default: 'indefinido' })
  contractType!: ContractType;

  /** Fecha de ingreso (YYYY-MM-DD). */
  @Prop({ trim: true })
  hireDate?: string;

  /** Fecha de fin de contrato para término fijo (YYYY-MM-DD). */
  @Prop({ trim: true })
  endDate?: string;

  @Prop({ min: 0 })
  salary?: number;

  @Prop({ enum: SALARY_TYPES })
  salaryType?: SalaryType;

  /** Jornada / horario (texto libre). */
  @Prop({ trim: true })
  workSchedule?: string;

  // ── Seguridad social ─────────────────────────────────────────────────────────
  /** EPS (salud). */
  @Prop({ trim: true })
  eps?: string;

  /** Fondo de pensiones (AFP). */
  @Prop({ trim: true })
  afp?: string;

  /** ARL (riesgos laborales). */
  @Prop({ trim: true })
  arl?: string;

  @Prop({ enum: ARL_RISK_LEVELS })
  arlRiskLevel?: ArlRiskLevel;

  /** Caja de compensación familiar. */
  @Prop({ trim: true })
  compensationFund?: string;

  /** Fondo de cesantías. */
  @Prop({ trim: true })
  severanceFund?: string;

  // ── Bancario (pago de nómina) ────────────────────────────────────────────────
  @Prop({ trim: true })
  bank?: string;

  @Prop({ enum: ACCOUNT_TYPES })
  accountType?: AccountType;

  @Prop({ trim: true })
  accountNumber?: string;

  // ── Documentos / certificados ────────────────────────────────────────────────
  @Prop({ type: [LegalDocumentSchema], default: [] })
  documents!: LegalDocument[];

  // ── Estado / vínculo ─────────────────────────────────────────────────────────
  @Prop({ enum: EMPLOYEE_STATUS, default: 'activo' })
  status!: EmployeeStatus;

  /** Fecha de retiro (YYYY-MM-DD). */
  @Prop({ trim: true })
  terminationDate?: string;

  @Prop({ trim: true })
  terminationReason?: string;

  /** Usuario del sistema vinculado (login/POS), si aplica. */
  @Prop({ trim: true })
  userId?: string;

  @Prop({ trim: true })
  notes?: string;
}

export const EmployeeSchema = SchemaFactory.createForClass(Employee);

EmployeeSchema.index({ docType: 1, docNumber: 1 }, { unique: true });
EmployeeSchema.index({ lastName: 1, firstName: 1 });
