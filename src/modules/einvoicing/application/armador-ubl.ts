import { BadRequestException, Injectable, NotImplementedException } from '@nestjs/common';
import type { ElectronicDocumentDocument } from '../infrastructure/schemas/electronic-document.schema';
import { armarFacturaUbl, codigoSeguridadSoftware } from '../domain/ubl/factura-ubl';
import { prepararFacturaUbl, type DocumentoParaUbl } from '../domain/ubl/factura-de-documento';
import { DocumentoUblInvalidoError } from '../domain/ubl/xml-ubl';
import { FiscalEmittersService } from './fiscal-emitters.service';
import { MENSAJE_BUILDER_PENDIENTE, type ArmadorXmlDian } from './transmision-dian.puertos';

const MENSAJE_SIN_EMISOR = 'Falta configurar: la sede no tiene emisor fiscal para armar la factura.';
const MENSAJE_SIN_PIN = 'Falta configurar: el PIN del software de factura del emisor.';

/**
 * Armador real del XML UBL 2.1 (Fase 5A) para el puerto `ArmadorXmlDian`.
 *
 * - Factura de venta (`invoice`): `prepararFacturaUbl` valida el documento
 *   (cuadre al centavo, emisor, adquiriente, resolución) ANTES de leer el PIN;
 *   un rechazo es 400 y el documento se queda como estaba, sin firma, sin
 *   bucket y sin red (el orden lo garantiza `TransmisionDianService`).
 * - Los demás tipos (POS, notas, nómina) siguen en 501 hasta sus fases.
 *
 * El PIN solo se usa para el `SoftwareSecurityCode` y no sale de este método:
 * no se loguea y ningún error lo cita (los mensajes son fijos o vienen del
 * builder, que nunca lo recibe).
 */
@Injectable()
export class ArmadorUblFactura implements ArmadorXmlDian {
  constructor(private readonly emisores: FiscalEmittersService) {}

  async armar(doc: ElectronicDocumentDocument): Promise<string> {
    if (doc.type !== 'invoice') throw new NotImplementedException(MENSAJE_BUILDER_PENDIENTE);

    const emisor = await this.emisores.obtenerPorSede(doc.sedeId.toString());
    if (!emisor) throw new BadRequestException(MENSAJE_SIN_EMISOR);

    const factura = this.dominio(() =>
      prepararFacturaUbl(doc as unknown as DocumentoParaUbl, {
        municipioDane: emisor.municipioDane,
        facturaSoftwareId: emisor.facturaSoftwareId,
        responsableIva: emisor.responsableIva,
        responsableInc: emisor.responsableInc,
        granContribuyente: emisor.granContribuyente,
        regimenRenta: emisor.regimenRenta,
      }),
    );

    const pin = await this.emisores.leerSecreto(emisor.id as string, 'facturaPin');
    if (!pin?.trim()) throw new BadRequestException(MENSAJE_SIN_PIN);
    return this.dominio(() =>
      armarFacturaUbl({
        ...factura,
        codigoSeguridadSoftware: codigoSeguridadSoftware(factura.softwareId, pin, factura.numero),
      }),
    );
  }

  /** Un documento que no se puede armar es un 400 con lo que hay que corregir. */
  private dominio<T>(fn: () => T): T {
    try {
      return fn();
    } catch (err) {
      if (err instanceof DocumentoUblInvalidoError) throw new BadRequestException(err.message);
      throw err;
    }
  }
}
