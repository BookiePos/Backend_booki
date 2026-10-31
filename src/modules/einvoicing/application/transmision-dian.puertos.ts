import { Inject, Injectable, NotImplementedException, Optional } from '@nestjs/common';
import type { TransmisorDian } from '../domain/transmisor-dian';
import type { TipoAmbiente } from '../domain/emisor-fiscal';
import { StubDian } from '../domain/stub-dian';
import { faltantesParaTransmitir, resolverTransmisor } from '../domain/resolver-transmisor';
import type { ElectronicDocumentDocument } from '../infrastructure/schemas/electronic-document.schema';
import { firmarXml } from '../infrastructure/firma/firma-xades';
import { abrirP12 } from '../infrastructure/firma/material-p12';
import { crearDirectoDian, type TransporteHttp } from '../infrastructure/dian/directo-dian';
import type { CredencialSoap } from '../infrastructure/dian/sobre-soap';
import { FiscalEmittersService } from './fiscal-emitters.service';

/**
 * Puertos de la transmisión a la DIAN (Fase 4B). El servicio de transmisión
 * solo habla con estas interfaces; las implementaciones por defecto viven aquí
 * y los tests las cambian por dobles.
 */

export const ARMADOR_XML_DIAN = Symbol('ARMADOR_XML_DIAN');
export const FIRMANTE_DIAN = Symbol('FIRMANTE_DIAN');
export const PROVEEDOR_TRANSMISOR_DIAN = Symbol('PROVEEDOR_TRANSMISOR_DIAN');
/** Transporte HTTP hacia la DIAN. Opcional: sin él, `fetch`. Los tests lo cambian por un doble. */
export const TRANSPORTE_HTTP_DIAN = Symbol('TRANSPORTE_HTTP_DIAN');

/** Motivo con el que queda en la auditoría la lectura del .p12 para WS-Security. */
export const MOTIVO_CERTIFICADO_TRANSMISION = 'transmision';

const MENSAJE_CERT_INUTILIZABLE =
  'Falta configurar: el certificado .p12 del emisor no se pudo abrir para transmitir';
const MENSAJE_DATOS_EMISOR =
  'Falta configurar: el NIT o el SoftwareID del emisor no sirven para transmitir a la DIAN';

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

/** El ambiente del emisor no es el que decidió el gate (cambió entre medias). */
export class AmbienteNoCoincideError extends Error {
  constructor() {
    super('El ambiente DIAN del emisor no coincide con el decidido para esta transmisión');
    this.name = 'AmbienteNoCoincideError';
  }
}

/**
 * Transmisor según el emisor real de la sede, para el ambiente que decidió el
 * gate. Si el emisor ya no está en ese ambiente, falla: nunca se transmite a
 * un ambiente distinto del decidido.
 *
 * `DirectoDian` solo se arma si el emisor tiene .p12 vigente, SoftwareID y PIN
 * y el .p12 abre; si no, stub con `CONFIG_FALTANTE` (nada sale a la red). El
 * material sale del .p12 del PROPIO emisor (lectura auditada con
 * `cargarCertificado`, abierto con `prepararP12` vía `abrirP12`): nunca hay
 * credencial global por env. La llave vive solo en el campo privado del
 * transmisor; aquí no se loguea ni se guarda, y un error al abrirla se
 * descarta (su texto podría citar el contenido del .p12).
 */
@Injectable()
export class ProveedorTransmisorPorEmisor implements ProveedorTransmisorDian {
  constructor(
    private readonly emisores: FiscalEmittersService,
    @Optional() @Inject(TRANSPORTE_HTTP_DIAN) private readonly transporte?: TransporteHttp,
  ) {}

  async para(sedeId: string, ambiente: TipoAmbiente): Promise<TransmisorDian> {
    const emisor = await this.emisores.obtenerPorSede(sedeId);
    if (!emisor || emisor.tipoAmbiente !== ambiente) throw new AmbienteNoCoincideError();
    const emisorId = emisor.id as string;
    const estado = await this.emisores.estadoConfiguracion(emisorId);
    // Sin lo mínimo no se toca el certificado (ni queda una lectura en la auditoría).
    if (faltantesParaTransmitir(estado).length > 0) return resolverTransmisor(estado);

    const material = await this.material(emisorId);
    if (!material) return new StubDian(MENSAJE_CERT_INUTILIZABLE);
    try {
      return resolverTransmisor(estado, () =>
        crearDirectoDian({
          material,
          // El del gate (ya comprobado igual al del emisor), nunca un valor por defecto.
          tipoAmbiente: ambiente,
          softwareId: estado.softwareId ?? '',
          nit: emisor.nitNorm,
          transporte: this.transporte,
        }),
      );
    } catch {
      // El constructor solo lanza por datos del emisor (NIT, SoftwareID): mensaje fijo.
      return new StubDian(MENSAJE_DATOS_EMISOR);
    }
  }

  /** Llave y certificado del .p12 del emisor, o `null` si no hay o no abre. */
  private async material(emisorId: string): Promise<CredencialSoap | null> {
    const cert = await this.emisores.cargarCertificado(emisorId, MOTIVO_CERTIFICADO_TRANSMISION);
    if (!cert) return null;
    try {
      const m = abrirP12(cert.p12, cert.password);
      return { llavePem: m.llavePem, certificadoB64: m.certificadoB64 };
    } catch {
      return null;
    }
  }
}
