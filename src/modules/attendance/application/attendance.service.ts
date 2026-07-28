import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AttendanceRecord,
  AttendanceRecordDocument,
} from '../infrastructure/schemas/attendance-record.schema';
import {
  Employee,
  EmployeeDocument,
} from '../../employees/infrastructure/schemas/employee.schema';
import { Sede, SedeDocument } from '../../sedes/infrastructure/schemas/sede.schema';
import { UpsertAttendanceDto } from './dto/upsert-attendance.dto';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  assertSedeAccess,
  allowedSedeIds,
} from '../../core-auth/domain/sede-access';

/** Empleado del expediente asignado a la sede (para el control de horas). */
export interface WorkerView {
  id: string;
  name: string;
  position: string;
}

/** Horas trabajadas acumuladas de un empleado en una sede (para "Turnos"). */
export interface AttendanceSummaryRow {
  userId: string;
  userName: string;
  sedeId: string;
  sedeName: string;
  hours: number;
  days: number;
}

/** Minutos desde medianoche de un "HH:MM". */
function toMinutes(hhmm: string): number {
  const parts = hhmm.split(':');
  return Number(parts[0] ?? 0) * 60 + Number(parts[1] ?? 0);
}

/** Horas entre dos "HH:MM" (cruza medianoche si salida < entrada). */
function computeHours(checkIn?: string, checkOut?: string): number {
  if (!checkIn || !checkOut) return 0;
  let mins = toMinutes(checkOut) - toMinutes(checkIn);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

interface SummaryAggRow {
  _id: { employeeId: string; sedeId: Types.ObjectId };
  employeeName: string;
  hours: number;
  days: number;
}

@Injectable()
export class AttendanceService {
  constructor(
    @InjectModel(AttendanceRecord.name)
    private readonly model: Model<AttendanceRecordDocument>,
    @InjectModel(Employee.name)
    private readonly employees: Model<EmployeeDocument>,
    @InjectModel(Sede.name)
    private readonly sedes: Model<SedeDocument>,
  ) {}

  /** Empleados (activos) asignados a la sede — del expediente de RRHH. */
  async workers(sedeId: string, user: JwtUser): Promise<WorkerView[]> {
    assertSedeAccess(user, sedeId);
    const docs = await this.employees
      .find({ sedeId: new Types.ObjectId(sedeId), status: 'activo' })
      .select('firstName lastName positionName')
      .sort({ lastName: 1, firstName: 1 })
      .exec();
    return docs.map((e) => ({
      id: e.id,
      name: `${e.firstName} ${e.lastName}`.trim(),
      position: e.positionName ?? '',
    }));
  }

  /** Registros de asistencia de una sede en un día. */
  list(
    sedeId: string,
    workDate: string,
    user: JwtUser,
  ): Promise<AttendanceRecordDocument[]> {
    assertSedeAccess(user, sedeId);
    return this.model
      .find({ sedeId: new Types.ObjectId(sedeId), workDate })
      .sort({ employeeName: 1 })
      .exec();
  }

  /**
   * Horas trabajadas por empleado y sede en un rango de fechas. Base de
   * "Turnos" / nómina. Alcance: si llega `sedeIdParam` se limita a esa sede
   * (con control de acceso); si no, agrega sobre las sedes que el usuario puede
   * ver (todas, para el dueño).
   */
  async summary(
    from: string,
    to: string,
    sedeIdParam: string | undefined,
    user: JwtUser,
  ): Promise<AttendanceSummaryRow[]> {
    const match: Record<string, unknown> = {
      workDate: { $gte: from, $lte: to },
      hours: { $gt: 0 },
    };
    if (sedeIdParam) {
      assertSedeAccess(user, sedeIdParam);
      match.sedeId = new Types.ObjectId(sedeIdParam);
    } else {
      const allowed = allowedSedeIds(user); // null = ve todas
      if (allowed) {
        match.sedeId = { $in: allowed.map((id) => new Types.ObjectId(id)) };
      }
    }

    const rows = await this.model.aggregate<SummaryAggRow>([
      { $match: match },
      {
        $group: {
          _id: { employeeId: '$employeeId', sedeId: '$sedeId' },
          employeeName: { $last: '$employeeName' },
          hours: { $sum: '$hours' },
          days: { $sum: 1 },
        },
      },
      { $sort: { employeeName: 1 } },
    ]);

    const sedeIds = [...new Set(rows.map((r) => String(r._id.sedeId)))];
    const sedeDocs = await this.sedes
      .find({ _id: { $in: sedeIds } })
      .select('name')
      .exec();
    const nameById = new Map(sedeDocs.map((s) => [s.id, s.name]));

    return rows.map((r) => ({
      userId: r._id.employeeId,
      userName: r.employeeName,
      sedeId: String(r._id.sedeId),
      sedeName: nameById.get(String(r._id.sedeId)) ?? 'Sede',
      hours: Math.round(r.hours * 100) / 100,
      days: r.days,
    }));
  }

  /**
   * Registra las horas de un empleado en un día. Write-once: una hora de
   * entrada o de salida ya registrada NO se puede modificar (solo se puede
   * completar la que aún falte). Así el control de horas es inmutable.
   */
  async upsert(
    dto: UpsertAttendanceDto,
    user: JwtUser,
  ): Promise<AttendanceRecordDocument> {
    assertSedeAccess(user, dto.sedeId);
    const sedeId = new Types.ObjectId(dto.sedeId);
    const existing = await this.model
      .findOne({ sedeId, employeeId: dto.employeeId, workDate: dto.workDate })
      .exec();

    // La hora ya registrada es inmutable: reintentar con el mismo valor es un
    // no-op, pero intentar cambiarla se rechaza.
    if (existing?.checkIn && dto.checkIn && dto.checkIn !== existing.checkIn) {
      throw new BadRequestException(
        'La hora de entrada ya fue registrada y no puede modificarse.',
      );
    }
    if (existing?.checkOut && dto.checkOut && dto.checkOut !== existing.checkOut) {
      throw new BadRequestException(
        'La hora de salida ya fue registrada y no puede modificarse.',
      );
    }

    // Lo ya guardado manda; solo se rellena lo que falte.
    const checkIn = existing?.checkIn ?? dto.checkIn;
    const checkOut = existing?.checkOut ?? dto.checkOut;
    const employee = Types.ObjectId.isValid(dto.employeeId)
      ? await this.employees
          .findById(dto.employeeId)
          .select('firstName lastName')
          .exec()
      : null;
    const employeeName = employee
      ? `${employee.firstName} ${employee.lastName}`.trim()
      : (existing?.employeeName ?? 'Empleado');
    const record = await this.model
      .findOneAndUpdate(
        { sedeId, employeeId: dto.employeeId, workDate: dto.workDate },
        {
          $set: {
            checkIn,
            checkOut,
            hours: computeHours(checkIn, checkOut),
            employeeName,
            note: dto.note ?? existing?.note,
            registeredByEmail: user.email,
          },
        },
        { upsert: true, new: true },
      )
      .exec();
    return record;
  }
}
