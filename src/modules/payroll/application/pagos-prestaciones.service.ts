import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Employee, EmployeeDocument } from '../../employees/infrastructure/schemas/employee.schema';
import {
  PayrollEDocument,
  PayrollEDocumentDocument,
} from '../../einvoicing/infrastructure/schemas/payroll-e-document.schema';
import {
  PayrollLiquidacion,
  PayrollLiquidacionDocument,
} from '../infrastructure/schemas/payroll-liquidacion.schema';
import {
  PayrollPagoPrestacion,
  PayrollPagoPrestacionDocument,
} from '../infrastructure/schemas/payroll-pago-prestacion.schema';
import { allowedSedeIds, type SedeScopeUser } from '../../core-auth/domain/sede-access';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import {
  NOMBRE_PRESTACION,
  avisosPagoPrestacion,
  diasCubiertos,
  motivoCruceConLiquidacion,
  motivoEmpleadoSinPrestacion,
  motivoPagoPrestacionInvalido,
  type DestinoCesantias,
  type TipoPrestacion,
} from '../domain/pago-prestacion';
import type { RegistrarPagoPrestacionDto } from './dto/pago-prestacion.dto';

type Usuario = SedeScopeUser & { email?: string };
type PagoPlano = PayrollPagoPrestacion & { _id: Types.ObjectId };
export type PagoPrestacionConAvisos = PagoPlano & { advertencias: string[] };

const plano = (doc: PayrollPagoPrestacionDocument | PagoPlano): PagoPlano =>
  (typeof (doc as PayrollPagoPrestacionDocument).toObject === 'function'
    ? (doc as PayrollPagoPrestacionDocument).toObject()
    : doc) as PagoPlano;

const AVISO_ASIENTO_PENDIENTE =
  'El pago quedó registrado, pero su asiento contable no se pudo guardar: quedó pendiente de conciliación. Vuelve a enviar el mismo pago para reintentarlo o avísale al contador.';

/**
 * Registro del pago de prima de servicios, cesantías (consignación al fondo) e
 * intereses sobre cesantías fuera del retiro (decisión 2 del dueño, Fase 8).
 *
 * Qué garantiza:
 * - Idempotente: un solo pago vivo por trabajador, prestación y tramo (índice
 *   único); reenviar el mismo pago devuelve el que ya existe y repara su asiento.
 * - Inmutable: no se edita. Se anula (contra-asiento) y se registra otro.
 * - Asiento: D 2610 / C 2365 (retención) / C 1105 o 1110, en la fecha real del
 *   pago (`lineasPagoPrestacion`). Best-effort como el resto del libro: si el
 *   posteo falla queda pendiente de conciliación y se avisa.
 * - Tenancy: los modelos son proxies del tenant de la request; las sedes del
 *   usuario limitan qué empleados ve (lo ajeno responde 404).
 */
@Injectable()
export class PagosPrestacionesService {
  constructor(
    @InjectModel(PayrollPagoPrestacion.name)
    private readonly pagos: Model<PayrollPagoPrestacionDocument>,
    @InjectModel(Employee.name)
    private readonly employees: Model<EmployeeDocument>,
    @InjectModel(PayrollLiquidacion.name)
    private readonly liquidaciones: Model<PayrollLiquidacionDocument>,
    @InjectModel(PayrollEDocument.name)
    private readonly nominaElectronica: Model<PayrollEDocumentDocument>,
    private readonly ledgerPosting: LedgerPostingService,
  ) {}

  private async empleadoEnAlcance(employeeId: string, user?: SedeScopeUser): Promise<EmployeeDocument> {
    const emp = Types.ObjectId.isValid(employeeId)
      ? await this.employees
          .findById(employeeId)
          .select('firstName lastName sedeId contractType salaryType hireDate')
          .exec()
      : null;
    const sedes = user ? allowedSedeIds(user) : null;
    if (!emp || (sedes !== null && (!emp.sedeId || !sedes.includes(String(emp.sedeId))))) {
      throw new NotFoundException('Empleado no encontrado');
    }
    return emp;
  }

  /** Asienta el pago (idempotente por origen). Devuelve los avisos que deja el libro. */
  private async postear(pago: PagoPlano): Promise<string[]> {
    const ok = await this.ledgerPosting.postPagoPrestacion({
      pagoId: String(pago._id),
      date: pago.pago.fecha,
      sedeId: pago.sedeId ? String(pago.sedeId) : undefined,
      concepto: NOMBRE_PRESTACION[pago.tipo],
      employeeName: pago.employeeName,
      partes: { monto: pago.monto, retencionFuente: pago.retencionFuente ?? 0, medio: pago.pago.medio },
      userEmail: pago.registradoPor,
    });
    return ok ? [] : [AVISO_ASIENTO_PENDIENTE];
  }

  /**
   * Si el mes del pago ya tiene un documento de nómina electrónica aceptado, el
   * pago (o su anulación) no llega solo a la DIAN: hay que corregir ese
   * documento con la nota de ajuste (Reemplazar), que recalcula con lo vigente.
   */
  private async avisoNominaAceptada(employeeId: string, fechaPago: string): Promise<string[]> {
    const periodo = fechaPago.slice(0, 7);
    const hay = await this.nominaElectronica
      .findOne({
        'empleado.employeeId': new Types.ObjectId(employeeId),
        periodo,
        tipoXml: { $in: ['102', '103'] },
        dianStatus: 'accepted',
        superado: { $ne: true },
      })
      .select('_id')
      .lean()
      .exec();
    return hay
      ? [
          `La nómina electrónica de ${periodo} de este trabajador ya fue aceptada por la DIAN. Para que refleje este cambio, corrígela en Nómina electrónica → «Corregir» (nota de ajuste que reemplaza el documento).`,
        ]
      : [];
  }

  /** El mismo pago reenviado: no se duplica. Si difiere de lo guardado, se rechaza. */
  private async yaRegistrado(existente: PagoPlano, dto: RegistrarPagoPrestacionDto): Promise<PagoPrestacionConAvisos> {
    const igual =
      existente.monto === dto.monto &&
      (existente.retencionFuente ?? 0) === (dto.retencionFuente ?? 0) &&
      existente.pago.medio === dto.medioPago &&
      existente.pago.fecha === dto.fechaPago;
    if (!igual) {
      throw new ConflictException(
        `Ya hay un pago de ${NOMBRE_PRESTACION[existente.tipo]} registrado para ese trabajador y ese periodo (${existente.periodoDesde} a ${existente.periodoHasta}) por ${existente.monto}, pagado el ${existente.pago.fecha}. Si está mal, anúlalo y regístralo de nuevo.`,
      );
    }
    // Reintento: repara el asiento si el posteo anterior falló (idempotente por origen).
    const avisos = await this.postear(existente);
    return { ...existente, advertencias: ['Este pago ya estaba registrado: no se duplicó.', ...avisos] };
  }

  async registrar(dto: RegistrarPagoPrestacionDto, user?: Usuario): Promise<PagoPrestacionConAvisos> {
    const emp = await this.empleadoEnAlcance(dto.employeeId, user);
    const motivo = motivoPagoPrestacionInvalido(dto, fechaColombia(new Date()));
    if (motivo) throw new BadRequestException(motivo);
    const tipo = dto.tipo as TipoPrestacion;
    const sinDerecho = motivoEmpleadoSinPrestacion(
      { contractType: emp.contractType, salaryType: emp.salaryType, hireDate: emp.hireDate },
      { tipo, periodoHasta: dto.periodoHasta },
    );
    if (sinDerecho) throw new BadRequestException(sinDerecho);

    const clave = { employeeId: dto.employeeId, tipo, estado: 'registrado' as const };
    const existente = (await this.pagos
      .findOne({ ...clave, periodoDesde: dto.periodoDesde, periodoHasta: dto.periodoHasta })
      .lean()
      .exec()) as PagoPlano | null;
    if (existente) return this.yaRegistrado(existente, dto);

    const cruzado = (await this.pagos
      .findOne({ ...clave, periodoDesde: { $lte: dto.periodoHasta }, periodoHasta: { $gte: dto.periodoDesde } })
      .lean()
      .exec()) as PagoPlano | null;
    // Entre las dos consultas pudo entrar el mismo pago (dos envíos a la vez): es el reintento, no un cruce.
    if (cruzado && cruzado.periodoDesde === dto.periodoDesde && cruzado.periodoHasta === dto.periodoHasta) {
      return this.yaRegistrado(cruzado, dto);
    }
    if (cruzado) {
      throw new ConflictException(
        `Ya hay un pago de ${NOMBRE_PRESTACION[tipo]} de ese trabajador que cubre del ${cruzado.periodoDesde} al ${cruzado.periodoHasta} y se cruza con este periodo: se pagaría dos veces. Ajusta las fechas o anula el anterior.`,
      );
    }
    const liq = await this.liquidaciones
      .findOne({ employeeId: dto.employeeId, estado: 'aprobada' })
      .select('fechaRetiro')
      .lean()
      .exec();
    const cruceLiq = motivoCruceConLiquidacion({ tipo, periodoHasta: dto.periodoHasta }, liq?.fechaRetiro);
    if (cruceLiq) throw new ConflictException(cruceLiq);

    const destino = tipo === 'cesantias' ? ((dto.destino ?? 'fondo') as DestinoCesantias) : undefined;
    let creado: PagoPlano;
    try {
      creado = plano(
        await this.pagos.create({
          employeeId: dto.employeeId,
          employeeName: [emp.firstName, emp.lastName].filter(Boolean).join(' ') || undefined,
          sedeId: emp.sedeId,
          tipo,
          monto: dto.monto,
          retencionFuente: dto.retencionFuente ?? 0,
          periodoDesde: dto.periodoDesde,
          periodoHasta: dto.periodoHasta,
          dias: diasCubiertos(dto.periodoDesde, dto.periodoHasta),
          pago: { medio: dto.medioPago, fecha: dto.fechaPago },
          ...(destino ? { destino } : {}),
          ...(dto.fondo?.trim() ? { fondo: dto.fondo.trim() } : {}),
          ...(dto.observacion?.trim() ? { observacion: dto.observacion.trim() } : {}),
          estado: 'registrado',
          registradoPor: user?.email,
        }),
      );
    } catch (err) {
      // Dos envíos a la vez: el índice único dejó pasar uno solo; el otro responde con ese.
      if ((err as { code?: number }).code !== 11000) throw err;
      const ganador = (await this.pagos
        .findOne({ ...clave, periodoDesde: dto.periodoDesde, periodoHasta: dto.periodoHasta })
        .lean()
        .exec()) as PagoPlano | null;
      if (!ganador) throw err;
      return this.yaRegistrado(ganador, dto);
    }
    const advertencias = [
      ...(await this.postear(creado)),
      ...avisosPagoPrestacion({ ...dto, destino }),
      ...(await this.avisoNominaAceptada(dto.employeeId, dto.fechaPago)),
    ];
    return { ...creado, advertencias };
  }

  /** Lista por la sede ACTUAL del empleado, como las liquidaciones. `anio` filtra por la fecha del pago. */
  async listar(
    filtros: { employeeId?: string; anio?: string; incluirAnulados?: boolean },
    user?: SedeScopeUser,
  ): Promise<PagoPlano[]> {
    const filtro: Record<string, unknown> = {};
    if (filtros.employeeId) {
      if (!Types.ObjectId.isValid(filtros.employeeId)) throw new BadRequestException('employeeId inválido');
      filtro.employeeId = filtros.employeeId;
    }
    if (filtros.anio) {
      if (!/^\d{4}$/.test(filtros.anio)) throw new BadRequestException('anio debe ser YYYY');
      filtro['pago.fecha'] = { $gte: `${filtros.anio}-01-01`, $lte: `${filtros.anio}-12-31` };
    }
    if (!filtros.incluirAnulados) filtro.estado = 'registrado';
    const sedes = user ? allowedSedeIds(user) : null;
    if (sedes) {
      const visibles = await this.employees
        .find({ sedeId: { $in: sedes.map((id) => new Types.ObjectId(id)) } })
        .select('_id')
        .exec();
      const ids = visibles.map((e) => String(e._id));
      filtro.employeeId = filtros.employeeId
        ? ids.includes(filtros.employeeId)
          ? filtros.employeeId
          : { $in: [] }
        : { $in: ids };
    }
    return (await this.pagos.find(filtro).sort({ 'pago.fecha': -1, createdAt: -1 }).limit(300).lean().exec()) as PagoPlano[];
  }

  /**
   * Anula un pago: pasa a `anulado` una sola vez (atómico) y se pide el
   * contra-asiento. Repetir la anulación no falla ni reversa dos veces
   * (`reverseBySource` no hace nada si ya está reversado): sirve de reintento
   * si el contra-asiento anterior no alcanzó a guardarse.
   */
  async anular(id: string, motivo: string | undefined, user?: Usuario): Promise<PagoPrestacionConAvisos> {
    const actual = Types.ObjectId.isValid(id) ? ((await this.pagos.findById(id).lean().exec()) as PagoPlano | null) : null;
    if (!actual) throw new NotFoundException('Pago de prestaciones no encontrado');
    // Quien ve todas las sedes puede anular aunque el empleado ya no esté en el expediente.
    if (user && allowedSedeIds(user) !== null) await this.empleadoEnAlcance(actual.employeeId, user);
    const anulado = (await this.pagos
      .findOneAndUpdate(
        { _id: actual._id, estado: 'registrado' },
        {
          $set: {
            estado: 'anulado',
            anuladoPor: user?.email,
            anuladoEn: new Date(),
            ...(motivo?.trim() ? { motivoAnulacion: motivo.trim() } : {}),
          },
        },
        { new: true },
      )
      .lean()
      .exec()) as PagoPlano | null;
    await this.ledgerPosting.reversePagoPrestacion(String(actual._id), user?.email);
    if (!anulado) {
      const ya = ((await this.pagos.findById(id).lean().exec()) as PagoPlano | null) ?? actual;
      return { ...ya, advertencias: ['Este pago ya estaba anulado.'] };
    }
    return { ...anulado, advertencias: await this.avisoNominaAceptada(anulado.employeeId, anulado.pago.fecha) };
  }
}
