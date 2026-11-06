import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { LedgerService } from '../application/ledger.service';
import { LedgerConciliacionService } from '../application/ledger-conciliacion.service';
import { CierreAnualService } from '../application/cierre-anual.service';
import {
  CreateAccountDto,
  CreateJournalEntryDto,
  ReverseEntryDto,
} from '../application/dto/ledger.dto';
import { RequirePermissions } from '../../core-auth/infrastructure/decorators/require-permissions.decorator';
import { CurrentUser } from '../../core-auth/infrastructure/decorators/current-user.decorator';
import { PERMISSIONS } from '../../core-auth/domain/permissions';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import {
  alcanceDeSedes,
  allowedSedeIds,
  resolveSedeScope,
} from '../../core-auth/domain/sede-access';
import {
  LineaConSede,
  balancePorSedes,
  lineasEnSedes,
} from '../domain/ledger-sede-scope';

/**
 * Libro contable. El alcance por sede (checklist 3.3) se aplica aquí y no en
 * `LedgerService`, que también lo usan los asientos automáticos de venta, caja
 * y nómina sin usuario de por medio. Ver `domain/ledger-sede-scope.ts`.
 *
 * El plan de cuentas (listar y crear cuentas) no se limita por sede: es el
 * mismo catálogo para toda la empresa y no contiene movimientos.
 */
@Controller('ledger')
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly conciliacion: LedgerConciliacionService,
    private readonly cierres: CierreAnualService,
  ) {}

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('accounts')
  listAccounts() {
    return this.ledger.listAccounts();
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('accounts')
  createAccount(@Body() dto: CreateAccountDto) {
    return this.ledger.createAccount(dto);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('entries')
  async listEntries(
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sourceType') sourceType?: string,
    @Query('accountCode') accountCode?: string,
    @Query('limit') limit?: string,
  ) {
    // `limit` no numérico o < 1 es 400: antes llegaba NaN al servicio.
    let pedido: number | undefined;
    if (limit !== undefined && limit !== '') {
      pedido = Number(limit);
      if (!Number.isInteger(pedido) || pedido < 1) {
        throw new BadRequestException('limit debe ser un entero positivo');
      }
    }
    const sedes = allowedSedeIds(user);
    if (!sedes) {
      return this.ledger.listEntries({
        from,
        to,
        sourceType,
        accountCode,
        limit: pedido,
      });
    }
    // Limitado por sede: el filtro («todos los renglones en mis sedes») y el
    // límite los aplica Mongo, así una sede tranquila no queda tapada por los
    // asientos recientes de las demás.
    return this.ledger.listEntries({
      from,
      to,
      sourceType,
      accountCode,
      limit: pedido,
      sedeIds: [...sedes],
    });
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('entries/:id')
  async getEntry(@Param('id') id: string, @CurrentUser() user: JwtUser) {
    const entry = await this.ledger.getEntry(id);
    this.assertAsientoEnAlcance(user, entry.lines);
    return entry;
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('entries')
  async postEntry(
    @Body() dto: CreateJournalEntryDto,
    @CurrentUser() user: JwtUser,
  ) {
    this.assertAsientoEnAlcance(user, dto.lines);
    return this.ledger.postFromDto(dto, user.email);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('entries/:id/reverse')
  async reverse(
    @Param('id') id: string,
    @CurrentUser() user: JwtUser,
    @Body() dto?: ReverseEntryDto,
  ) {
    const entry = await this.ledger.getEntry(id);
    this.assertAsientoEnAlcance(user, entry.lines);
    return this.ledger.reverse(id, user.email, dto?.date);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('trial-balance')
  async trialBalance(
    @CurrentUser() user: JwtUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('sedeId') sedeId?: string,
  ) {
    const sedes = resolveSedeScope(user, sedeId);
    const tb = await balancePorSedes(
      (q) => this.ledger.trialBalance(q),
      { from, to },
      sedes,
    );
    return { ...tb, ...alcanceDeSedes(sedes) };
  }

  /**
   * Asientos que el sistema no pudo escribir o reversar y están por conciliar
   * (checklist 1.13). Un pendiente no lleva sede, así que solo lo ve quien ve
   * finanzas de toda la empresa.
   */
  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('conciliacion')
  async pendientesDeConciliacion(@CurrentUser() user: JwtUser) {
    if (allowedSedeIds(user)) {
      throw new ForbiddenException(
        'Los pendientes de conciliación son de toda la empresa',
      );
    }
    const [total, items] = await Promise.all([
      this.conciliacion.contarAbiertos(),
      this.conciliacion.listarAbiertos(),
    ]);
    return { total, items };
  }

  // ── Cierre anual (R4, revisión contable 1.16) ──────────────────────────────
  // Es de toda la empresa (cancela las cuentas de resultados de todas las
  // sedes), así que quien está limitado por sede no lo ve ni lo dispara.

  @RequirePermissions(PERMISSIONS.FINANCE_VIEW)
  @Get('cierres')
  estadoCierres(@CurrentUser() user: JwtUser) {
    this.assertEmpresaEntera(user);
    return this.cierres.estado();
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('cierres/:anio')
  cerrarAnio(@Param('anio') anio: string, @CurrentUser() user: JwtUser) {
    this.assertEmpresaEntera(user);
    return this.cierres.cerrar(anio, user.email);
  }

  @RequirePermissions(PERMISSIONS.FINANCE_MANAGE)
  @Post('cierres/:anio/reabrir')
  reabrirAnio(@Param('anio') anio: string, @CurrentUser() user: JwtUser) {
    this.assertEmpresaEntera(user);
    return this.cierres.reabrir(anio, user.email);
  }

  private assertEmpresaEntera(user: JwtUser): void {
    if (allowedSedeIds(user)) {
      throw new ForbiddenException('El cierre anual es de toda la empresa');
    }
  }

  /**
   * Un usuario limitado por sede solo ve, registra o reversa asientos cuyos
   * renglones caen todos en sus sedes. Un renglón sin sede es de la empresa.
   */
  private assertAsientoEnAlcance(
    user: JwtUser,
    lines: readonly LineaConSede[],
  ): void {
    const sedes = allowedSedeIds(user);
    if (sedes && !lineasEnSedes(lines, sedes)) {
      throw new ForbiddenException(
        'Este asiento toca sedes a las que no tienes acceso',
      );
    }
  }
}
