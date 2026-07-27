import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  AttendanceRecord,
  AttendanceRecordSchema,
} from './infrastructure/schemas/attendance-record.schema';
import {
  User,
  UserSchema,
} from '../core-auth/infrastructure/schemas/user.schema';
import { AttendanceService } from './application/attendance.service';
import { AttendanceController } from './infrastructure/attendance.controller';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AttendanceRecord.name, schema: AttendanceRecordSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [AttendanceController],
  providers: [AttendanceService],
  exports: [AttendanceService],
})
export class AttendanceModule {}
