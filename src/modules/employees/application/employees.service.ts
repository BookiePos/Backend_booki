import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  Employee,
  EmployeeDocument,
} from '../infrastructure/schemas/employee.schema';
import {
  Position,
  PositionDocument,
} from '../infrastructure/schemas/position.schema';
import {
  allowedSedeIds,
  assertSedeAccess,
  type SedeScopeUser,
} from '../../core-auth/domain/sede-access';
import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';
import {
  AccountType,
  ArlRiskLevel,
  ContractType,
  DocStatus,
  EmpDocType,
  EmployeeStatus,
  Gender,
  SalaryType,
} from '../domain/employees.constants';

const MONGO_DUPLICATE_KEY = 11000;

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: number }).code === MONGO_DUPLICATE_KEY
  );
}

/** Cadena vacía → undefined (para poder limpiar campos opcionales). */
function orUndef(v?: string): string | undefined {
  return v ? v : undefined;
}

/** Prefijo con el que la API devuelve el número de cuenta enmascarado. */
export const MASCARA_CUENTA = '••••';

/** `••••1234` (últimos 4 dígitos); vacío si no hay cuenta. */
export function enmascararCuenta(cuenta?: string | null): string | undefined {
  if (!cuenta) return undefined;
  // Una cuenta corta nunca sale entera: con ≤4 caracteres solo los últimos 2
  // (o ninguno si tiene ≤2).
  const visibles = cuenta.length > 4 ? 4 : cuenta.length > 2 ? 2 : 0;
  return `${MASCARA_CUENTA}${visibles ? cuenta.slice(-visibles) : ''}`;
}

/** Empleado como lo ve la API: sin el número de cuenta completo. */
export type EmpleadoVista = Record<string, unknown> & {
  accountNumber?: string;
  tieneCuenta: boolean;
};

@Injectable()
export class EmployeesService {
  constructor(
    @InjectModel(Employee.name)
    private readonly model: Model<EmployeeDocument>,
    @InjectModel(Position.name)
    private readonly positions: Model<PositionDocument>,
  ) {}

  /**
   * Vista PÚBLICA del empleado para las respuestas de la API: el número de
   * cuenta sale enmascarado (`••••1234`) y se añade `tieneCuenta`. El número
   * completo sigue guardado; el consolidador de nómina lo lee con
   * `list()` / `getOrFail()` / `create()` / `update()`, que devuelven el
   * documento crudo (uso interno: NO los serialices tal cual en un controlador).
   */
  aVista(emp: EmployeeDocument): EmpleadoVista {
    const plano = (
      typeof emp.toObject === 'function' ? emp.toObject() : { ...emp }
    ) as unknown as Record<string, unknown> & { accountNumber?: string };
    return {
      ...plano,
      accountNumber: enmascararCuenta(plano.accountNumber),
      tieneCuenta: !!plano.accountNumber,
    };
  }

  /**
   * Alcance por sede (ítem 3.9). Sin `user` (seeds, nómina) no se filtra.
   * Quien no ve todas las sedes solo ve a los de las suyas: los empleados sin
   * sede son de la empresa y quedan para quien la ve entera.
   */
  list(user?: SedeScopeUser): Promise<EmployeeDocument[]> {
    const sedes = user ? allowedSedeIds(user) : null;
    const filter = sedes
      ? { sedeId: { $in: sedes.map((id) => new Types.ObjectId(id)) } }
      : {};
    return this.model.find(filter).sort({ lastName: 1, firstName: 1 }).exec();
  }

  async create(
    dto: CreateEmployeeDto,
    user?: SedeScopeUser,
  ): Promise<EmployeeDocument> {
    if (user) this.assertSedeDestino(user, dto.sedeId);
    const emp = new this.model();
    await this.apply(emp, dto);
    try {
      await emp.save();
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(
          `Ya existe un empleado con el documento ${emp.docType} ${emp.docNumber}`,
        );
      }
      throw err;
    }
    return emp;
  }

  async update(
    id: string,
    dto: UpdateEmployeeDto,
    user?: SedeScopeUser,
  ): Promise<EmployeeDocument> {
    const emp = await this.getOrFail(id, user);
    if (user && dto.sedeId !== undefined) this.assertSedeDestino(user, dto.sedeId);
    await this.apply(emp, dto);
    try {
      await emp.save();
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        throw new ConflictException(
          `Ya existe un empleado con el documento ${emp.docType} ${emp.docNumber}`,
        );
      }
      throw err;
    }
    return emp;
  }

  async remove(id: string, user?: SedeScopeUser): Promise<void> {
    const emp = await this.getOrFail(id, user);
    await emp.deleteOne();
  }

  /** Con `user`, el de otra sede (o sin sede) da 404, igual que si no existiera. */
  async getOrFail(id: string, user?: SedeScopeUser): Promise<EmployeeDocument> {
    const emp = Types.ObjectId.isValid(id)
      ? await this.model.findById(id).exec()
      : null;
    if (!emp || (user && !this.enAlcance(user, emp.sedeId))) {
      throw new NotFoundException('Empleado no encontrado');
    }
    return emp;
  }

  private enAlcance(user: SedeScopeUser, sedeId?: Types.ObjectId): boolean {
    const sedes = allowedSedeIds(user);
    return sedes === null || (!!sedeId && sedes.includes(sedeId.toString()));
  }

  /**
   * Quien no ve todas las sedes solo asigna a las suyas, y no puede dejar a
   * nadie sin sede: lo sacaría de su propio alcance y de cualquier otro
   * limitado.
   */
  private assertSedeDestino(user: SedeScopeUser, sedeId?: string): void {
    if (allowedSedeIds(user) === null) return;
    if (!sedeId) {
      throw new ForbiddenException('Asigna el empleado a una de tus sedes');
    }
    assertSedeAccess(user, sedeId);
  }

  /** Listado mínimo de empleados activos (para selectores del POS). */
  async lookup(): Promise<
    { _id: string; firstName: string; lastName: string; docNumber: string }[]
  > {
    const emps = await this.model
      .find({ status: 'activo' })
      .select('firstName lastName docNumber')
      .sort({ firstName: 1, lastName: 1 })
      .exec();
    return emps.map((e) => ({
      _id: String(e._id),
      firstName: e.firstName,
      lastName: e.lastName,
      docNumber: e.docNumber,
    }));
  }

  /** Aplica el DTO al documento (crear o actualizar). */
  private async apply(
    emp: EmployeeDocument,
    dto: CreateEmployeeDto | UpdateEmployeeDto,
  ): Promise<void> {
    // Identificación
    if (dto.docType !== undefined) emp.docType = dto.docType as EmpDocType;
    if (dto.docNumber !== undefined) emp.docNumber = dto.docNumber;
    if (dto.firstName !== undefined) emp.firstName = dto.firstName;
    if (dto.lastName !== undefined) emp.lastName = dto.lastName;
    if (dto.birthDate !== undefined) emp.birthDate = orUndef(dto.birthDate);
    if (dto.gender !== undefined) emp.gender = orUndef(dto.gender) as Gender;
    if (dto.phone !== undefined) emp.phone = orUndef(dto.phone);
    if (dto.email !== undefined) emp.email = orUndef(dto.email);
    if (dto.address !== undefined) emp.address = orUndef(dto.address);
    if (dto.city !== undefined) emp.city = orUndef(dto.city);
    if (dto.emergencyContactName !== undefined)
      emp.emergencyContactName = orUndef(dto.emergencyContactName);
    if (dto.emergencyContactPhone !== undefined)
      emp.emergencyContactPhone = orUndef(dto.emergencyContactPhone);

    // Contratación
    if (dto.positionId !== undefined) {
      if (dto.positionId) {
        emp.positionId = new Types.ObjectId(dto.positionId);
        const pos = await this.positions
          .findById(dto.positionId)
          .select('name')
          .exec();
        emp.positionName = pos?.name;
      } else {
        emp.positionId = undefined;
        emp.positionName = undefined;
      }
    }
    if (dto.sedeId !== undefined) {
      emp.sedeId = dto.sedeId ? new Types.ObjectId(dto.sedeId) : undefined;
    }
    if (dto.contractType !== undefined)
      emp.contractType = dto.contractType as ContractType;
    if (dto.hireDate !== undefined) emp.hireDate = orUndef(dto.hireDate);
    if (dto.endDate !== undefined) emp.endDate = orUndef(dto.endDate);
    if (dto.salary !== undefined) emp.salary = dto.salary;
    if (dto.salaryType !== undefined)
      emp.salaryType = orUndef(dto.salaryType) as SalaryType;
    if (dto.workSchedule !== undefined)
      emp.workSchedule = orUndef(dto.workSchedule);

    // Seguridad social
    if (dto.eps !== undefined) emp.eps = orUndef(dto.eps);
    if (dto.afp !== undefined) emp.afp = orUndef(dto.afp);
    if (dto.arl !== undefined) emp.arl = orUndef(dto.arl);
    if (dto.arlRiskLevel !== undefined)
      emp.arlRiskLevel = orUndef(dto.arlRiskLevel) as ArlRiskLevel;
    if (dto.compensationFund !== undefined)
      emp.compensationFund = orUndef(dto.compensationFund);
    if (dto.severanceFund !== undefined)
      emp.severanceFund = orUndef(dto.severanceFund);

    // Bancario
    if (dto.bank !== undefined) emp.bank = orUndef(dto.bank);
    if (dto.accountType !== undefined)
      emp.accountType = orUndef(dto.accountType) as AccountType;
    // Un formulario que reenvía EXACTAMENTE el valor enmascarado actual no debe
    // pisar el número real: se ignora. Cualquier otro valor que empiece por la
    // máscara es un intento de edición a medias: 400. `''` limpia.
    if (dto.accountNumber !== undefined) {
      const cuenta = dto.accountNumber.trim();
      if (!cuenta.startsWith(MASCARA_CUENTA)) {
        emp.accountNumber = orUndef(cuenta);
      } else if (cuenta !== enmascararCuenta(emp.accountNumber)) {
        throw new BadRequestException(
          'Para cambiar la cuenta borra el campo y escribe el número completo',
        );
      }
    }

    // Documentos / certificados
    if (dto.documents !== undefined) {
      emp.set(
        'documents',
        dto.documents.map((d) => ({
          type: d.type,
          number: orUndef(d.number),
          issueDate: orUndef(d.issueDate),
          expiryDate: orUndef(d.expiryDate),
          status: (d.status as DocStatus) ?? 'pendiente',
          note: orUndef(d.note),
        })),
      );
    }

    // Estado / vínculo
    if (dto.status !== undefined) emp.status = dto.status as EmployeeStatus;
    if (dto.terminationDate !== undefined)
      emp.terminationDate = orUndef(dto.terminationDate);
    if (dto.terminationReason !== undefined)
      emp.terminationReason = orUndef(dto.terminationReason);
    if (dto.userId !== undefined) emp.userId = orUndef(dto.userId);
    if (dto.notes !== undefined) emp.notes = orUndef(dto.notes);

    // Nómina electrónica DIAN
    if (dto.secondLastName !== undefined) emp.secondLastName = orUndef(dto.secondLastName);
    if (dto.otherNames !== undefined) emp.otherNames = orUndef(dto.otherNames);
    if (dto.docTypeDian !== undefined) emp.docTypeDian = orUndef(dto.docTypeDian);
    if (dto.tipoTrabajador !== undefined) emp.tipoTrabajador = orUndef(dto.tipoTrabajador);
    if (dto.subTipoTrabajador !== undefined)
      emp.subTipoTrabajador = orUndef(dto.subTipoTrabajador);
    if (dto.altoRiesgoPension !== undefined) emp.altoRiesgoPension = dto.altoRiesgoPension;
    if (dto.tipoContratoDian !== undefined) emp.tipoContratoDian = orUndef(dto.tipoContratoDian);
    if (dto.municipioDaneTrabajo !== undefined)
      emp.municipioDaneTrabajo = orUndef(dto.municipioDaneTrabajo);
    if (dto.direccionTrabajo !== undefined)
      emp.direccionTrabajo = orUndef(dto.direccionTrabajo);
    if (dto.medioPago !== undefined) emp.medioPago = orUndef(dto.medioPago);
  }
}
