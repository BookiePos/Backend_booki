import { Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
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
import { UsersService } from './application/users.service';
import { RolesService } from './application/roles.service';
import { AuthService } from './application/auth.service';
import { MailService } from './application/mail.service';
import { InvitationsService } from './application/invitations.service';
import { JwtStrategy } from './infrastructure/jwt.strategy';
import { AuthController } from './infrastructure/auth.controller';
import { UsersController } from './infrastructure/users.controller';
import { RolesController } from './infrastructure/roles.controller';
import { InvitationsController } from './infrastructure/invitations.controller';
import { JwtAuthGuard } from './infrastructure/guards/jwt-auth.guard';
import { PermissionsGuard } from './infrastructure/guards/permissions.guard';

@Module({
  imports: [
    PassportModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Invitation.name, schema: InvitationSchema },
      { name: RefreshToken.name, schema: RefreshTokenSchema },
    ]),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions =>
        ({
          secret: config.get<string>('JWT_SECRET') ?? 'dev-secret',
          signOptions: {
            expiresIn: config.get<string>('JWT_ACCESS_EXPIRES') ?? '15m',
          },
        }) as JwtModuleOptions,
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
    MailService,
    InvitationsService,
    JwtStrategy,
    // Guards globales: autenticación + permisos en toda la API.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [UsersService, RolesService, MailService],
})
export class CoreAuthModule {}
