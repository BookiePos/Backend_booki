import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { ACC } from '../domain/ledger.constants';
import { fechaColombia } from '../domain/fecha-contable';
import {
  ORIGEN_CIERRE,
  ORIGEN_TRASLADO,
  ORIGENES_FUERA_DE_RESULTADOS,
  anioValido,
  armarCierre,
  armarTraslado,
  finDeAnio,
  inicioDeAnio,
} from '../domain/cierre-anual';

/** Estado de un año en la pantalla de cierre. */
export interface EstadoAnio {
  anio: number;
  cerrado: boolean;
  /** El año ya terminó y se puede cerrar (si los anteriores están cerrados). */
  puedeCerrar: boolean;
  /** Utilidad (+) o pérdida (−) del año según el libro, sin el cierre. */
  resultado: number;
  cierre: {
    number: string;
    date: string;
    createdByEmail?: string;
    trasladoNumber: string | null;
  } | null;
  /**
   * Año cerrado con saldo en cuentas de resultados: entró un asiento
   * automático con fecha de ese año después del cierre. Se arregla
   * reabriendo y volviendo a cerrar.
   */
  saldoPosteriorAlCierre: number;
}

/**
 * Cierre anual manual desde el panel (R4 de la revisión contable 1.16; el
 * dueño eligió manual sobre automático). Reglas en `domain/cierre-anual.ts`.
 *
 * Orden obligatorio: un año se cierra solo si los anteriores ya no tienen
 * saldo en resultados (si no, el cierre arrastraría sus utilidades), y se
 * reabre solo si el siguiente sigue abierto.
 */
@Injectable()
export class CierreAnualService {
  constructor(private readonly ledger: LedgerService) {}

  private anioActual(): number {
    return Number(fechaColombia().slice(0, 4));
  }

  async estado(): Promise<EstadoAnio[]> {
    const actual = this.anioActual();
    const anios = await this.ledger.aniosConMovimiento();
    const out: EstadoAnio[] = [];
    let anterioresCerrados = true;
    for (const anio of anios) {
      const cierre = await this.ledger.findBySource(ORIGEN_CIERRE, String(anio));
      const traslado = cierre
        ? await this.ledger.findBySource(ORIGEN_TRASLADO, String(anio))
        : null;
      const tb = await this.ledger.trialBalance({
        from: inicioDeAnio(anio),
        to: finDeAnio(anio),
        excluirOrigenes: ORIGENES_FUERA_DE_RESULTADOS,
      });
      const resultado = tb.rows
        .filter((r) => r.type === 'income' || r.type === 'expense')
        .reduce((a, r) => a + (r.type === 'income' ? r.balance : -r.balance), 0);
      // Suma de valores absolutos: un +x y un −x residuales no se tapan.
      const saldoPosteriorAlCierre = cierre
        ? (await this.ledger.saldosDeResultado(finDeAnio(anio))).reduce(
            (a, s) => a + Math.abs(s.credit - s.debit),
            0,
          )
        : 0;
      out.push({
        anio,
        cerrado: !!cierre,
        puedeCerrar: !cierre && anio < actual && anterioresCerrados,
        resultado,
        cierre: cierre
          ? {
              number: cierre.number,
              date: cierre.date,
              createdByEmail: cierre.createdByEmail,
              trasladoNumber: traslado?.number ?? null,
            }
          : null,
        saldoPosteriorAlCierre,
      });
      if (!cierre && anio < actual) anterioresCerrados = false;
    }
    return out;
  }

  async cerrar(anioTexto: string, email: string) {
    const anio = this.validar(anioTexto);
    if (anio >= this.anioActual()) {
      throw new BadRequestException(
        `El año ${anio} no ha terminado: solo se cierra un año ya vencido.`,
      );
    }
    const existente = await this.ledger.findBySource(ORIGEN_CIERRE, String(anio));
    if (existente) {
      // Reintento tras una falla entre los dos asientos: completa el traslado.
      const traslado = await this.trasladar(anio, existente, email);
      if (traslado.creado) return { anio, cierre: existente, traslado: traslado.asiento };
      throw new ConflictException(`El año ${anio} ya está cerrado.`);
    }

    const pendientes = await this.ledger.saldosDeResultado(finDeAnio(anio - 1));
    if (pendientes.length > 0) {
      throw new BadRequestException(
        `Hay ingresos o gastos de ${anio - 1} o antes sin cerrar: cierra primero esos años, en orden.`,
      );
    }
    const { renglones, resultado } = armarCierre(
      await this.ledger.saldosDeResultado(finDeAnio(anio)),
    );
    if (renglones.length < 2) {
      throw new BadRequestException(
        `El año ${anio} no tiene ingresos ni gastos que cerrar.`,
      );
    }
    const cierre = await this.ledger.post({
      date: finDeAnio(anio),
      sourceType: ORIGEN_CIERRE,
      sourceId: String(anio),
      memo: `Cierre del ejercicio ${anio}: cuentas de resultados a la 3605 (${resultado >= 0 ? 'utilidad' : 'pérdida'} de ${Math.abs(resultado)})`,
      lines: renglones,
      createdByEmail: email,
    });
    const traslado = await this.trasladar(anio, cierre, email);
    return { anio, resultado, cierre, traslado: traslado.asiento };
  }

  async reabrir(anioTexto: string, email: string) {
    const anio = this.validar(anioTexto);
    const cierre = await this.ledger.findBySource(ORIGEN_CIERRE, String(anio));
    if (!cierre) throw new BadRequestException(`El año ${anio} no está cerrado.`);
    if (await this.ledger.anioCerrado(anio + 1)) {
      throw new BadRequestException(
        `El año ${anio + 1} está cerrado: reábrelo primero.`,
      );
    }
    // Primero el traslado y después el cierre, cada uno con su propia fecha:
    // así la reversa no cae en el año en curso ni lo ensucia.
    const traslado = await this.ledger.findBySource(ORIGEN_TRASLADO, String(anio));
    if (traslado) {
      await this.ledger.reverse(traslado._id.toString(), email, traslado.date, {
        reabriendoCierre: true,
      });
    }
    await this.ledger.reverse(cierre._id.toString(), email, cierre.date, {
      reabriendoCierre: true,
    });
    return { anio, reabierto: true };
  }

  private validar(anioTexto: string): number {
    const anio = anioValido(anioTexto);
    if (anio === null) throw new BadRequestException('El año debe ser YYYY');
    return anio;
  }

  /** Postea el traslado 3605 → 3705 si falta. Idempotente por origen. */
  private async trasladar(
    anio: number,
    cierre: { lines: { accountCode: string; debit: number; credit: number; sedeId?: unknown }[] },
    email: string,
  ) {
    const ya = await this.ledger.findBySource(ORIGEN_TRASLADO, String(anio));
    if (ya) return { creado: false, asiento: ya };
    const lineas = armarTraslado(
      cierre.lines.filter((l) => l.accountCode === ACC.RESULTADO_EJERCICIO),
    );
    if (lineas.length < 2) return { creado: false, asiento: null };
    const asiento = await this.ledger.post({
      date: inicioDeAnio(anio + 1),
      sourceType: ORIGEN_TRASLADO,
      sourceId: String(anio),
      memo: `Traslado del resultado de ${anio} a resultados de ejercicios anteriores (3705)`,
      lines: lineas,
      createdByEmail: email,
    });
    return { creado: true, asiento };
  }
}
