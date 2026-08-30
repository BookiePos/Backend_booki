import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../application/auth.service';
import { UsersService } from '../application/users.service';
import { RegistrationService } from '../application/registration.service';
import { LoginDto } from '../application/dto/login.dto';
import { RefreshDto } from '../application/dto/refresh.dto';
import { RegisterDto } from '../application/dto/register.dto';
import { ForgotPasswordDto } from '../application/dto/forgot-password.dto';
import { ResetPasswordDto } from '../application/dto/reset-password.dto';
import { PasswordResetService } from '../application/password-reset.service';
import { Public } from './decorators/public.decorator';
import { NoPermissionRequired } from './decorators/no-permission-required.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtUser } from './jwt.strategy';
import {
  REFRESH_COOKIE,
  setRefreshCookie,
  clearRefreshCookie,
} from './auth-cookie';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly registration: RegistrationService,
    private readonly passwordReset: PasswordResetService,
    private readonly config: ConfigService,
  ) {}

  /** Toma el refresh token de la cookie HttpOnly; acepta el body como respaldo
   *  para clientes aún no migrados. */
  private refreshTokenFrom(req: Request, dto: RefreshDto): string | undefined {
    const fromCookie = (req.cookies as Record<string, string> | undefined)?.[
      REFRESH_COOKIE
    ];
    return fromCookie ?? dto.refreshToken;
  }

  // Anti fuerza-bruta: 5 intentos por 5 minutos por IP.
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(dto.email, dto.password);
    setRefreshCookie(res, result.tokens.refreshToken, this.config);
    return result;
  }

  /** Alta pública de una empresa nueva (tenant) + su dueño. */
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @Public()
  @Post('register')
  @HttpCode(201)
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.registration.register(dto);
    setRefreshCookie(res, result.tokens.refreshToken, this.config);
    return result;
  }

  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = this.refreshTokenFrom(req, dto);
    if (!token) {
      throw new UnauthorizedException('Refresh token ausente');
    }
    const tokens = await this.auth.refresh(token);
    setRefreshCookie(res, tokens.refreshToken, this.config);
    return tokens;
  }

  /**
   * Pide el correo con el enlace de recuperación.
   *
   * Responde 202 siempre, exista o no la cuenta: si distinguiéramos los casos,
   * este formulario serviría para averiguar qué correos están registrados.
   */
  @Throttle({ default: { limit: 5, ttl: 900_000 } })
  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.passwordReset.request(dto.email);
    return {
      ok: true,
      message:
        'Si la cuenta existe, enviamos un correo con el enlace para cambiar la contraseña.',
    };
  }

  /** Valida el enlace antes de mostrar el formulario de nueva contraseña. */
  @Throttle({ default: { limit: 20, ttl: 900_000 } })
  @Public()
  @Get('reset-password/:token')
  async validateReset(@Param('token') token: string) {
    return this.passwordReset.validate(token);
  }

  /** Aplica la nueva contraseña. Deja al usuario sin sesiones: vuelve a entrar. */
  @Throttle({ default: { limit: 10, ttl: 900_000 } })
  @Public()
  @Post('reset-password/:token')
  @HttpCode(204)
  async resetPassword(
    @Param('token') token: string,
    @Body() dto: ResetPasswordDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.passwordReset.reset(token, dto.password);
    // La cookie de refresh que hubiera en este navegador ya no sirve (todas las
    // sesiones quedaron revocadas): se limpia para no dejar basura.
    clearRefreshCookie(res, this.config);
  }

  // Cierra la sesión del propio usuario: solo requiere estar autenticado.
  @NoPermissionRequired()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = this.refreshTokenFrom(req, dto);
    if (token) await this.auth.logout(token);
    clearRefreshCookie(res, this.config);
  }

  // Perfil del propio usuario: solo requiere estar autenticado.
  @NoPermissionRequired()
  @Get('me')
  async me(@CurrentUser() current: JwtUser) {
    const user = await this.users.findById(current.userId);
    return this.auth.me(user);
  }
}
