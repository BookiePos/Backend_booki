import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  AttendanceRecord,
  AttendanceRecordDocument,
} from '../infrastructure/schemas/attendance-record.schema';
import {
  User,
  UserDocument,
} from '../../core-auth/infrastructure/schemas/user.schema';
import { UpsertAttendanceDto } from './dto/upsert-attendance.dto';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { assertSedeAccess } from '../../core-auth/domain/sede-access';

export interface WorkerView {
  id: string;
  name: string;
  email: string;
  role: string;
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

@Injectable()
export class AttendanceService {
  constructor(
    @InjectModel(AttendanceRecord.name)
    private readonly model: Model<AttendanceRecordDocument>,
    @InjectModel(User.name)
    private readonly users: Model<UserDocument>,
  ) {}

  /** Trabajadores vinculados a la sede (activos). */
  async workers(sedeId: string, user: JwtUser): Promise<WorkerView[]> {
    assertSedeAccess(user, sedeId);
    const docs = await this.users
      .find({ sedeIds: new Types.ObjectId(sedeId), active: true })
      .select('name email role')
      .sort({ name: 1 })
      .exec();
    return docs.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
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
      .sort({ userName: 1 })
      .exec();
  }

  /** Registra/actualiza las horas de un trabajador en un día. */
  async upsert(
    dto: UpsertAttendanceDto,
    user: JwtUser,
  ): Promise<AttendanceRecordDocument> {
    assertSedeAccess(user, dto.sedeId);
    const sedeId = new Types.ObjectId(dto.sedeId);
    const existing = await this.model
      .findOne({ sedeId, userId: dto.userId, workDate: dto.workDate })
      .exec();
    const checkIn = dto.checkIn ?? existing?.checkIn;
    const checkOut = dto.checkOut ?? existing?.checkOut;
    const worker = Types.ObjectId.isValid(dto.userId)
      ? await this.users.findById(dto.userId).select('name').exec()
      : null;
    const record = await this.model
      .findOneAndUpdate(
        { sedeId, userId: dto.userId, workDate: dto.workDate },
        {
          $set: {
            checkIn,
            checkOut,
            hours: computeHours(checkIn, checkOut),
            userName: worker?.name ?? existing?.userName ?? 'Trabajador',
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
