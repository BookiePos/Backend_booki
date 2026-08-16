import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from '../application/auth.service';
import { UsersService } from '../application/users.service';
import { RegistrationService } from '../application/registration.service';
import { LoginDto } from '../application/dto/login.dto';
import { RefreshDto } from '../application/dto/refresh.dto';
import { RegisterDto } from '../application/dto/register.dto';
import { Public } from './decorators/public.decorator';
import { NoPermissionRequired } from './decorators/no-permission-required.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtUser } from './jwt.strategy';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly registration: RegistrationService,
  ) {}

  // Anti fuerza-bruta: 5 intentos por 5 minutos por IP.
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Alta pública de una empresa nueva (tenant) + su dueño. */
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @Public()
  @Post('register')
  @HttpCode(201)
  register(@Body() dto: RegisterDto) {
    return this.registration.register(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  // Cierra la sesión del propio usuario: solo requiere estar autenticado.
  @NoPermissionRequired()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.auth.logout(dto.refreshToken);
  }

  // Perfil del propio usuario: solo requiere estar autenticado.
  @NoPermissionRequired()
  @Get('me')
  async me(@CurrentUser() current: JwtUser) {
    const user = await this.users.findById(current.userId);
    return this.auth.me(user);
  }
}
