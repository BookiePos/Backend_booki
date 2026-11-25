import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PayrollQuincena,
  PayrollQuincenaDocument,
} from '../infrastructure/schemas/payroll-quincena.schema';
import {
  PayrollRun,
  PayrollRunDocument,
} from '../infrastructure/schemas/payroll-run.schema';
import {
  Employee,
  EmployeeDocument,
} from '../../employees/infrastructure/schemas/employee.schema';
import {
  PayrollNovedad,
  PayrollNovedadDocument,
} from '../infrastructure/schemas/payroll-novedad.schema';
import {
  AttendanceRecord,
  AttendanceRecordDocument,
} from '../../attendance/infrastructure/schemas/attendance-record.schema';
import { diasALiquidar } from '../domain/descanso-remunerado';
import { classifyTurnos, lunesDe } from '../domain/turnos-classify';
import { jornadaSemanalVigente, type NovedadHoras } from '../domain/payroll-calc';
import { LedgerPostingService } from '../../core-ledger/application/ledger-posting.service';
import { fechaColombia } from '../../core-ledger/domain/fecha-contable';
import { sumBy } from '../../finance/domain/money.util';
import { esDuplicadoEn } from '../../core-ledger/domain/journal-entry.indices';
import { INDICE_QUINCENA_VIVA } from '../domain/payroll-quincena.indices';
import { JwtUser } from '../../core-auth/infrastructure/jwt.strategy';
import { allowedSedeIds, assertSedeAccess } from '../../core-auth/domain/sede-access';
import { motivoPagoInvalido } from '../domain/pago-nomina';
import type { ArlLevel, SalaryType } from '../domain/payroll-calc';
import {
  calcularPrimeraQuincena,
  diasPrimeraQuincena,
  DIA_CORTE_QUINCENA,
} from '../domain/quincena-calc';
import { filtroNominables, PayrollService } from './payroll.service';
import { RegistrarQuincenaDto } from './dto/quincena.dto';
import { contar } from '../../../shared/texto/contar';

/** Lo que se mostraría para pagar la primera quincena de un trabajador. */
export interface PropuestaQuincena {
  employeeId: string;
  employeeName: string;
  sedeId?: string;
  dias: number;
  sueldo: number;
  auxilioTransporte: number;
  /** Recargos nocturnos y dominicales de los turnos del 1 al 15. */
  recargos: number;
  /** Horas extra de los turnos del 1 al 15. */
  horasExtra: number;
  /** Horas de recargo y extra por tipo, para mostrar de dónde sale la plata. */
  horas: NovedadHoras;
  salud: number;
  pension: number;
  fsp: number;
  neto: number;
  tope: number;
  /** Por qué no se le paga (días en 0) o qué tener en cuenta. */
  avisos: string[];
}

/**
 * Primera quincena del mes (decisión de Paulo, 20-nov-2026; revisión contable
 * del mismo día). Ver `domain/quincena-calc.ts` para las reglas del cálculo y
 * `PayrollQuincena` para cómo encaja con el cierre del mes.
 */
@Injectable()
export class QuincenaService {
  constructor(
    @InjectModel(PayrollQuincena.name)
    private readonly quincenas: Model<PayrollQuincenaDocument>,
    @InjectModel(PayrollRun.name)
    private readonly runs: Model<PayrollRunDocument>,
    @InjectModel(Employee.name)
    private readonly employees: Model<EmployeeDocument>,
    @InjectModel(PayrollNovedad.name)
    private readonly novedades: Model<PayrollNovedadDocument>,
    @InjectModel(AttendanceRecord.name)
    private readonly asistencia: Model<AttendanceRecordDocument>,
    private readonly payroll: PayrollService,
    private readonly ledgerPosting: LedgerPostingService,
  ) {}

  /** Mismo alcance que la nómina del mes: quien no ve todas las sedes paga solo una de las suyas. */
  private alcance(user: JwtUser, coverage: string, sedeId?: string): void {
    if (allowedSedeIds(user) !== null) {
      if (coverage !== 'sede' || !sedeId) {
        throw new ForbiddenException('Solo puedes pagar la quincena de una de tus sedes.');
      }
      assertSedeAccess(user, sedeId);
    }
    if (coverage === 'sede' && !sedeId) {
      throw new BadRequestException('Elige la sede.');
    }
  }

  /** Propuesta de pago de la primera quincena de `period` para la cobertura. */
  async propuesta(
    period: string,
    coverage: string,
    sedeId: string | undefined,
    user: JwtUser,
  ): Promise<{ period: string; corte: string; lineas: PropuestaQuincena[]; yaPagados: string[]; cerrada: boolean }> {
    this.alcance(user, coverage, sedeId);
    const corte = `${period}-${String(DIA_CORTE_QUINCENA).padStart(2, '0')}`;
    const filtro: Record<string, unknown> = filtroNominables(period);
    if (coverage === 'sede') filtro.sedeId = new Types.ObjectId(sedeId);
    const emps = await this.employees.find(filtro).sort({ lastName: 1, firstName: 1 }).exec();
    const ids = emps.map((e) => e.id as string);

    const yaPagado = await this.payroll.pagadoEnQuincena(period, ids);
    const cerradas = await this.runs
      .find({ period, status: 'cerrada', 'slips.employeeId': { $in: ids } })
      .select('_id')
      .exec();
    const novs = await this.novedades
      .find({ employeeId: { $in: ids }, estado: 'activa', fechaInicio: { $lte: corte }, fechaFin: { $gte: `${period}-01` } })
      .select('employeeId fechaInicio fechaFin')
      .exec();
    const s = await this.payroll.parametrosEn(corte);
    // Los días se cuentan como en la nómina del mes: por los turnos registrados
    // (más los descansos que se ganan). Si no, la quincena pagaría días que el
    // cierre después no reconoce y el trabajador quedaría debiendo.
    const desde = `${period}-01`;
    const turnos = await this.asistencia
      .find({ employeeId: { $in: ids }, workDate: { $gte: lunesDe(desde), $lte: corte } })
      .select('employeeId workDate checkIn checkOut')
      .exec();

    const lineas: PropuestaQuincena[] = [];
    for (const e of emps) {
      if (yaPagado.has(e.id)) continue;
      const ausencias = novs.filter((n) => n.employeeId === e.id);
      const cal = diasPrimeraQuincena(
        period,
        { hireDate: e.hireDate, terminationDate: e.terminationDate },
        ausencias,
      );
      const fechasAusencia: string[] = [];
      for (const a of ausencias) {
        for (let d = a.fechaInicio; d <= a.fechaFin; d = sumarUnDia(d)) fechasAusencia.push(d);
      }
      // Horas extra y recargos del 1 al 15, clasificados igual que en el cierre
      // del mes: sin los días de ausencia (no se pagan dos veces) y con la semana
      // anterior al día 1 para el tope semanal de la jornada.
      const enAusencia = (d: string) => ausencias.some((a) => d >= a.fechaInicio && d <= a.fechaFin);
      const registros = turnos
        .filter((t) => t.employeeId === e.id && !enAusencia(t.workDate))
        .map((t) => ({ workDate: t.workDate, checkIn: t.checkIn, checkOut: t.checkOut }));
      const clasif = classifyTurnos(registros, {
        desde,
        jornadaSemanal: (f) => jornadaSemanalVigente(f, s),
      });
      const sinSalida = registros.filter((t) => t.workDate >= desde && t.checkIn && !t.checkOut).length;
      const trabajados = new Set([
        ...turnos.filter((t) => t.employeeId === e.id && t.checkIn).map((t) => t.workDate),
        ...fechasAusencia,
      ]);
      const conTurnos = Math.max(
        0,
        diasALiquidar(trabajados, desde, corte, s.diasLaborablesSemana ?? 6) - cal.ausentes,
      );
      const dias = Math.min(cal.dias, conTurnos);
      const motivo =
        cal.motivo ??
        (dias === 0 ? 'No tiene turnos registrados del 1 al 15. Regístralos en Equipo → Turnos.' : undefined);
      const nombre = `${e.firstName} ${e.lastName}`.trim();
      if (dias === 0) {
        lineas.push({
          employeeId: e.id,
          employeeName: nombre,
          sedeId: e.sedeId ? String(e.sedeId) : undefined,
          dias: 0,
          sueldo: 0,
          auxilioTransporte: 0,
          recargos: 0,
          horasExtra: 0,
          horas: {},
          salud: 0,
          pension: 0,
          fsp: 0,
          neto: 0,
          tope: 0,
          avisos: motivo ? [motivo] : [],
        });
        continue;
      }
      const c = calcularPrimeraQuincena(
        {
          salario: e.salary ?? 0,
          salaryType: ((e.salaryType as SalaryType) ?? 'ordinario'),
          arlRiskLevel: e.arlRiskLevel as ArlLevel | undefined,
        },
        dias,
        s,
        corte,
        clasif.horas,
      );
      const avisos: string[] = [];
      if (e.salaryType !== 'integral' && (e.salary ?? 0) < s.smmlv) {
        avisos.push(`Gana menos que el salario mínimo de ${corte.slice(0, 4)}.`);
      }
      if (conTurnos < cal.dias) {
        avisos.push(`Tiene turnos para ${dias} de ${cal.dias} días. Si faltan turnos, regístralos antes de pagar.`);
      } else if (dias < 15) {
        avisos.push(`Se le pagan ${dias} de 15 días (ingreso o ausencias registradas).`);
      }
      if (sinSalida > 0) {
        avisos.push(`${contar(sinSalida, 'turno')} sin hora de salida: ese día se paga, pero sin horas extra ni recargos. Corrígelo en Equipo → Turnos.`);
      }
      const bruto = c.sueldo + c.auxilioTransporte + c.recargos + c.horasExtra - c.salud - c.pension - c.fsp;
      if (c.recargos + c.horasExtra > 0 && c.neto + 1 < bruto) {
        avisos.push('Se le paga la mitad de lo que gana en el mes; el resto de sus horas extra y recargos va en la segunda quincena.');
      }
      if (c.retencionEstimadaMes > 0) {
        avisos.push('Tiene retención en la fuente: se le descuenta completa en la segunda quincena.');
      }
      lineas.push({
        employeeId: e.id,
        employeeName: nombre,
        sedeId: e.sedeId ? String(e.sedeId) : undefined,
        dias,
        ...c,
        horas: e.salaryType === 'integral' ? {} : soloConHoras(clasif.horas),
        avisos,
      });
    }
    return {
      period,
      corte,
      lineas,
      yaPagados: [...yaPagado.keys()],
      cerrada: cerradas.length > 0,
    };
  }

  /**
   * Registra el pago de la primera quincena. El servidor recalcula cada línea:
   * del cliente solo se acepta pagar MENOS de lo calculado. Asienta D 2505 /
   * C caja o bancos y recalcula las nóminas en borrador del mes.
   */
  async registrar(
    dto: RegistrarQuincenaDto,
    user: JwtUser,
  ): Promise<{ quincena: PayrollQuincenaDocument; avisos: string[] }> {
    this.alcance(user, dto.coverage, dto.sedeId);
    const motivo = motivoPagoInvalido(dto.period, dto.medioPago, dto.fechaPago, fechaColombia(new Date()));
    if (motivo) throw new BadRequestException(motivo);
    if (dto.fechaPago.slice(0, 7) !== dto.period) {
      throw new BadRequestException('La primera quincena se paga dentro del mismo mes.');
    }
    const prop = await this.propuesta(dto.period, dto.coverage, dto.sedeId, user);
    if (prop.cerrada) {
      throw new BadRequestException(
        `La nómina de ${dto.period} ya está cerrada: lo que se pague va en la nómina del mes siguiente.`,
      );
    }
    // La quincena y la nómina del mes se hacen con la misma cobertura: la
    // quincena debita la 2505 en la sede (o sin sede) y el cierre la vuelve a
    // acreditar en la suya. Si no coinciden, la 2505 queda con saldo por sede.
    const ids = dto.lineas.map((l) => l.employeeId);
    const nominas = await this.runs
      .find({ period: dto.period, 'slips.employeeId': { $in: ids } })
      .select('coverage sedeId')
      .exec();
    const distinta = nominas.find(
      (r) => r.coverage !== dto.coverage || (dto.coverage === 'sede' && String(r.sedeId) !== dto.sedeId),
    );
    if (distinta) {
      throw new BadRequestException(
        distinta.coverage === 'all'
          ? 'La nómina de este mes ya se calculó para toda la empresa: paga la quincena también para toda la empresa.'
          : 'La nómina de este mes ya se calculó por sede: paga la quincena de esa misma sede.',
      );
    }
    const porId = new Map(prop.lineas.map((l) => [l.employeeId, l]));
    const vistos = new Set<string>();
    const lineas = dto.lineas.map((pedida) => {
      if (vistos.has(pedida.employeeId)) {
        throw new BadRequestException('Un trabajador aparece dos veces en el pago.');
      }
      vistos.add(pedida.employeeId);
      if (prop.yaPagados.includes(pedida.employeeId)) {
        throw new BadRequestException('A uno de los trabajadores ya se le pagó la primera quincena de este mes.');
      }
      const l = porId.get(pedida.employeeId);
      if (!l || l.dias === 0 || l.neto <= 0) {
        throw new BadRequestException(
          `${l?.employeeName ?? 'Un trabajador'} no tiene días para pagar en la primera quincena.`,
        );
      }
      const neto = pedida.neto ?? l.neto;
      if (neto > l.neto) {
        throw new BadRequestException(
          `A ${l.employeeName} se le pueden pagar hasta ${l.neto.toLocaleString('es-CO')} en la primera quincena.`,
        );
      }
      return {
        employeeId: l.employeeId,
        employeeName: l.employeeName,
        ...(l.sedeId ? { sedeId: new Types.ObjectId(l.sedeId) } : {}),
        dias: l.dias,
        sueldo: l.sueldo,
        auxilioTransporte: l.auxilioTransporte,
        recargos: l.recargos,
        horasExtra: l.horasExtra,
        salud: l.salud,
        pension: l.pension,
        fsp: l.fsp,
        neto,
      };
    });
    const total = sumBy(lineas, (l) => l.neto);
    let quincena: PayrollQuincenaDocument;
    try {
      quincena = await this.quincenas.create({
        period: dto.period,
        coverage: dto.coverage,
        sedeId: dto.coverage === 'sede' ? new Types.ObjectId(dto.sedeId) : null,
        estado: 'pagada',
        pago: { medio: dto.medioPago, fecha: dto.fechaPago },
        lineas,
        total,
        registradaPor: user.email,
      });
    } catch (err) {
      // Dos pagos a la vez (doble clic): el índice deja pasar solo uno.
      if (esDuplicadoEn(err, INDICE_QUINCENA_VIVA)) {
        throw new BadRequestException('A uno de los trabajadores ya se le pagó la primera quincena de este mes.');
      }
      throw err;
    }
    // Si el mes se cerró mientras se registraba, el cierre no descontó esta
    // quincena: se deshace antes de asentar nada y el trabajador no cobra doble.
    const cerroEntreTanto = await this.runs
      .exists({ period: dto.period, status: 'cerrada', 'slips.employeeId': { $in: ids } })
      .exec();
    if (cerroEntreTanto) {
      await this.quincenas.deleteOne({ _id: quincena._id }).exec();
      throw new BadRequestException(
        `La nómina de ${dto.period} se cerró mientras registrabas la quincena: lo que se pague va en la nómina del mes siguiente.`,
      );
    }
    await this.ledgerPosting.postPagoSalarios({
      sourceType: 'pago_quincena',
      sourceId: quincena._id.toString(),
      date: dto.fechaPago,
      sedeId: dto.coverage === 'sede' ? dto.sedeId : undefined,
      monto: total,
      medio: dto.medioPago,
      memo: `Primera quincena de ${dto.period}`,
      userEmail: user.email,
    });
    const avisos = await this.payroll.recalcularBorradoresDelPeriodo(dto.period, user);
    return { quincena, avisos };
  }

  async listar(period: string | undefined, user: JwtUser): Promise<PayrollQuincenaDocument[]> {
    const filtro: Record<string, unknown> = period ? { period } : {};
    const sedes = allowedSedeIds(user);
    if (sedes !== null) {
      filtro.coverage = 'sede';
      filtro.sedeId = { $in: sedes.map((id) => new Types.ObjectId(id)) };
    }
    return this.quincenas.find(filtro).sort({ createdAt: -1 }).limit(50).exec();
  }

  /**
   * Anula un pago de quincena registrado por error: contra-asiento y las
   * nóminas en borrador del mes vuelven a no descontarlo. No se puede si la
   * nómina del mes ya se cerró: el cierre ya lo descontó.
   */
  async anular(id: string, motivo: string | undefined, user: JwtUser): Promise<{ quincena: PayrollQuincenaDocument; avisos: string[] }> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Pago de quincena no encontrado.');
    const q = await this.quincenas.findById(id).exec();
    if (!q) throw new NotFoundException('Pago de quincena no encontrado.');
    this.alcance(user, q.coverage, q.sedeId ? String(q.sedeId) : undefined);
    if (q.estado === 'anulada') throw new BadRequestException('Este pago ya está anulado.');
    const cerrada = await this.runs
      .exists({ period: q.period, status: 'cerrada', 'slips.employeeId': { $in: q.lineas.map((l) => l.employeeId) } })
      .exec();
    if (cerrada) {
      throw new BadRequestException(
        `La nómina de ${q.period} ya se cerró y descontó esta quincena. Corrígelo con tu contador en la nómina siguiente.`,
      );
    }
    q.estado = 'anulada';
    q.anuladaPor = user.email;
    q.anuladaEn = new Date();
    q.motivoAnulacion = motivo?.trim() || undefined;
    await q.save();
    // Escribe primero y comprueba después (igual que `closeRun`): si el mes se
    // cerró mientras se anulaba, el cierre ya descontó esta quincena y
    // reversarla le quitaría esa plata al trabajador.
    const cerroEntreTanto = await this.runs
      .exists({ period: q.period, status: 'cerrada', 'slips.employeeId': { $in: q.lineas.map((l) => l.employeeId) } })
      .exec();
    if (cerroEntreTanto) {
      q.estado = 'pagada';
      q.anuladaPor = undefined;
      q.anuladaEn = undefined;
      q.motivoAnulacion = undefined;
      await q.save();
      throw new BadRequestException(
        `La nómina de ${q.period} se cerró mientras anulabas la quincena y ya la descontó. Corrígelo con tu contador en la nómina siguiente.`,
      );
    }
    await this.ledgerPosting.reversePagoSalarios('pago_quincena', q._id.toString(), user.email);
    const avisos = await this.payroll.recalcularBorradoresDelPeriodo(q.period, user);
    return { quincena: q, avisos };
  }
}

/** Solo los tipos de hora que tienen algo. */
function soloConHoras(h: Required<NovedadHoras>): NovedadHoras {
  return Object.fromEntries(Object.entries(h).filter(([, v]) => v > 0));
}

/** El día siguiente (YYYY-MM-DD). */
function sumarUnDia(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
