import { Injectable, NotImplementedException } from '@nestjs/common';
import type { TransmisorDian } from '../domain/transmisor-dian';
import type { TipoAmbiente } from '../domain/emisor-fiscal';
import type { ElectronicDocumentDocument } from '../infrastructure/schemas/electronic-document.schema';
import { firmarXml } from '../infrastructure/firma/firma-xades';
import { FiscalEmittersService } from './fiscal-emitters.service';

/**
 * Puertos de la transmisión a la DIAN (Fase 4B). El servicio de transmisión
 * solo habla con estas interfaces; las implementaciones por defecto viven aquí
 * y los tests las cambian por dobles.
 */

export const ARMADOR_XML_DIAN = Symbol('ARMADOR_XML_DIAN');
export const FIRMANTE_DIAN = Symbol('FIRMANTE_DIAN');
export const PROVEEDOR_TRANSMISOR_DIAN = Symbol('PROVEEDOR_TRANSMISOR_DIAN');

/** Arma el XML UBL 2.1 SIN firmar del documento (con la ranura de la firma vacía). */
export interface ArmadorXmlDian {
  armar(doc: ElectronicDocumentDocument): Promise<string>;
}

/** Firma un XML con el certificado del emisor. */
export interface FirmanteDian {
  firmar(xml: string, emisorId: string): Promise<string>;
}

/** Transmisor del emisor de la sede para el ambiente ya decidido por el gate. */
export interface ProveedorTransmisorDian {
  para(sedeId: string, ambiente: TipoAmbiente): Promise<TransmisorDian>;
}

export const MENSAJE_BUILDER_PENDIENTE = 'Builder UBL pendiente (Fase 5)';

/**
 * Hasta la Fase 5 no hay builder UBL: armar lanza y el documento se queda en
 * `draft` sin consumir nada más (ni firma, ni bucket, ni red).
 */
@Injectable()
export class ArmadorUblPendiente implements ArmadorXmlDian {
  armar(_doc: ElectronicDocumentDocument): Promise<string> {
    return Promise.reject(new NotImplementedException(MENSAJE_BUILDER_PENDIENTE));
  }
}

/** El emisor no tiene .p12 cargado o falta la llave para descifrar su contraseña. */
export class FirmaNoDisponibleError extends Error {
  constructor() {
    super('El emisor no tiene un certificado .p12 utilizable para firmar');
    this.name = 'FirmaNoDisponibleError';
  }
}

/**
 * Firma XAdES-EPES con el .p12 del emisor. El certificado se lee en el
 * servidor (`cargarCertificado` deja la lectura en la auditoría) y no sale de
 * esta función.
 */
@Injectable()
export class FirmanteP12 implements FirmanteDian {
  constructor(private readonly emisores: FiscalEmittersService) {}

  async firmar(xml: string, emisorId: string): Promise<string> {
    const cert = await this.emisores.cargarCertificado(emisorId, 'firma');
    if (!cert) throw new FirmaNoDisponibleError();
    return firmarXml(xml, { p12: cert.p12, password: cert.password });
  }
}

/**
 * Transmisor según el emisor real de la sede. Hoy `resolverTransmisor` siempre
 * devuelve el stub; `DirectoDian` (por ambiente) se conecta en un PR aparte.
 */
@Injectable()
export class ProveedorTransmisorPorEmisor implements ProveedorTransmisorDian {
  constructor(private readonly emisores: FiscalEmittersService) {}

  para(sedeId: string, _ambiente: TipoAmbiente): Promise<TransmisorDian> {
    return this.emisores.transmisorParaSede(sedeId);
  }
}
