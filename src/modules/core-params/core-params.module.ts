import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Parameter,
  ParameterSchema,
} from './infrastructure/schemas/parameter.schema';
import { CoreAuthModule } from '../core-auth/core-auth.module';
import { ParamsService } from './application/params.service';
import { ParamsController } from './infrastructure/params.controller';

@Module({
  imports: [
    CoreAuthModule,
    MongooseModule.forFeature([
      { name: Parameter.name, schema: ParameterSchema },
    ]),
  ],
  controllers: [ParamsController],
  providers: [ParamsService],
  exports: [ParamsService],
})
export class CoreParamsModule {}
