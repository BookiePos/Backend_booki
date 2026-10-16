import { Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import {
  jwtRefreshSecret,
  jwtSecret,
} from '../../shared/config/jwt-secrets';
import { TenantMongooseModule } from '../../shared/tenancy/tenant-mongoose.module';
import { APP_GUARD } from '@nestjs/core';
import { User, UserSchema } from './infrastructure/schemas/user.schema';
import { Role, RoleSchema } from './infrastructure/schemas/role.schema';
import {
  Invitation,
  InvitationSchema,
} from './infrastructure/schemas/invitation.schema';
import {
  RefreshToken,
  RefreshTokenSchema,
} from './infrastructure/schemas/refresh-token.schema';
import { ControlModule } from '../control/control.module';
import { SedesModule } from '../sedes/sedes.module';
import { UsersService } from './application/users.service';
import { RolesService } from './application/roles.service';
import { IntentosLoginService } from './application/intentos-login.service';
import { AuthService } from './application/auth.service';
import { RegistrationService } from './application/registration.service';
import { MailService } from './application/mail.service';
import { InvitationsService } from './application/invitations.service';
import { PasswordResetService } from './application/password-reset.service';
import { JwtStrategy } from './infrastructure/jwt.strategy';
import { AuthController } from './infrastructure/auth.controller';
import { UsersController } from './infrastructure/users.controller';
import { RolesController } from './infrastructure/roles.controller';
import { InvitationsController } from './infrastructure/invitations.controller';
import { JwtAuthGuard } from './infrastructure/guards/jwt-auth.guard';
import { PermissionsGuard } from './infrastructure/guards/permissions.guard';
import { FeatureGuard } from './infrastructure/guards/feature.guard';

@Module({
  imports: [
    PassportModule,
    ControlModule,
    SedesModule,
    TenantMongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Invitation.name, schema: InvitationSchema },
      { name: RefreshToken.name, schema: RefreshTokenSchema },
    ]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => {
        // Ítem 3.7: el secreto de refresh se lee al refrescar, no al arrancar.
        // Se valida aquí para que un entorno sin él (o con el mismo valor que
        // el de acceso) no arranque, en vez de fallar en el primer login.
        jwtRefreshSecret(config);
        return {
          secret: jwtSecret(config),
          signOptions: {
            expiresIn: config.get<string>('JWT_ACCESS_EXPIRES') ?? '15m',
          },
        } as JwtModuleOptions;
      },
    }),
  ],
  controllers: [
    AuthController,
    UsersController,
    RolesController,
    InvitationsController,
  ],
  providers: [
    UsersService,
    RolesService,
    AuthService,
    RegistrationService,
    MailService,
    InvitationsService,
    PasswordResetService,
    IntentosLoginService,
    JwtStrategy,
    // Guards globales: autenticación + permisos en toda la API.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_GUARD, useClass: FeatureGuard },
  ],
  exports: [UsersService, RolesService, MailService],
})
export class CoreAuthModule {}
