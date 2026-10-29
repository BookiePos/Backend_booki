import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import {
  REGIMEN_RENTA,
  RESPONSABILIDAD_FISCAL,
  TIPO_PERSONA,
} from '../../../sedes/domain/sede.constants';
import {
  TIPO_AMBIENTE_POR_DEFECTO,
  TIPOS_AMBIENTE,
} from '../../domain/emisor-fiscal';
import {
  campoSecreto,
  type SecretoCifrado,
} from '../../../../shared/crypto/secretos';

export type FiscalEmitterDocument = HydratedDocument<FiscalEmitter>;

/**
 * Emisor fiscal: uno por NIT normalizado en la base de cada empresa (checklist
 * 1, Fase 1). Las sedes apuntan a él con `sede.emisorId`; dos sedes con el mismo
 * NIT comparten emisor, porque el .p12, el SoftwareID y el PIN son por NIT.
 *
 * SECRETOS: `facturaPin`, `nominaPin` y `certPasswordCifrada` van cifrados con
 * `campoSecreto()` (select: false, fuera de `toJSON`). Su contexto es siempre
 * `contextoSecreto(emisorId, '<nombre del campo>')`. Nunca se devuelven en un
 * DTO: la pantalla recibe `FiscalEmittersService.vista()`, con booleanos.
 */
@Schema({ timestamps: true, collection: 'fiscal_emitters' })
export class FiscalEmitter {
  // ── Identidad fiscal (copiada de la sede por la migración) ─────────────────
  @Prop({ type: String, trim: true })
  razonSocial?: string;

  /** NIT tal como lo escribió el negocio. */
  @Prop({ type: String, required: true, trim: true })
  nit!: string;

  /** NIT base sin DV, solo dígitos (`normalizarNit`): la llave del emisor. */
  @Prop({ type: String, required: true })
  nitNorm!: string;

  @Prop({ type: String, trim: true })
  nitDv?: string;

  @Prop({ type: String, enum: TIPO_PERSONA })
  tipoPersona?: string;

  // Responsabilidades del RUT, los mismos campos que hoy tiene la sede.
  @Prop({ type: String, enum: RESPONSABILIDAD_FISCAL })
  responsabilidadFiscal?: string;

  @Prop({ type: Boolean })
  responsableIva?: boolean;

  @Prop({ type: Boolean })
  responsableInc?: boolean;

  @Prop({ type: Boolean })
  franquicia?: boolean;

  @Prop({ type: Boolean })
  granContribuyente?: boolean;

  @Prop({ type: String, enum: REGIMEN_RENTA })
  regimenRenta?: string;

  @Prop({ type: String, trim: true })
  ciiu?: string;

  // ── Domicilio y contacto ────────────────────────────────────────────────────
  @Prop({ type: String, trim: true })
  direccion?: string;

  @Prop({ type: String, trim: true })
  departamento?: string;

  @Prop({ type: String, trim: true })
  ciudad?: string;

  /**
   * Código DANE del municipio (5 dígitos). La sede no lo tiene: solo guarda el
   * nombre de la ciudad, así que la migración no lo rellena.
   */
  @Prop({ type: String, trim: true })
  municipioDane?: string;

  @Prop({ type: String, trim: true })
  telefono?: string;

  @Prop({ type: String, trim: true, lowercase: true })
  emailFacturacion?: string;

  // ── Habilitación ────────────────────────────────────────────────────────────
  /** '1' producción, '2' habilitación. Viaja en el CUFE. */
  @Prop({ type: String, enum: TIPOS_AMBIENTE, default: TIPO_AMBIENTE_POR_DEFECTO })
  tipoAmbiente!: string;

  /** Lo enciende BookiPos tras pasar el set de pruebas, nunca el negocio. */
  @Prop({ type: Boolean, default: false })
  habilitado!: boolean;

  // ── Credenciales DIAN de factura ────────────────────────────────────────────
  /** SoftwareID que asigna la DIAN. No es secreto: viaja en el XML. */
  @Prop({ type: String, trim: true })
  facturaSoftwareId?: string;

  @Prop(campoSecreto())
  facturaPin?: SecretoCifrado;

  @Prop({ type: String, trim: true })
  facturaTestSetId?: string;

  // ── Credenciales DIAN de nómina (Fase 8), aparte de las de factura ─────────
  @Prop({ type: String, trim: true })
  nominaSoftwareId?: string;

  @Prop(campoSecreto())
  nominaPin?: SecretoCifrado;

  @Prop({ type: String, trim: true })
  nominaTestSetId?: string;

  // ── Certificado .p12: solo metadata; el archivo lo sube la Fase 3 ──────────
  /** Ruta en el bucket privado. */
  @Prop({ type: String, trim: true })
  certPath?: string;

  @Prop({ type: Date })
  certVenceAt?: Date;

  @Prop({ type: String, trim: true })
  certTitular?: string;

  @Prop(campoSecreto())
  certPasswordCifrada?: SecretoCifrado;
}

export const FiscalEmitterSchema = SchemaFactory.createForClass(FiscalEmitter);

/** Un emisor por NIT normalizado en cada empresa. */
FiscalEmitterSchema.index({ nitNorm: 1 }, { unique: true, name: 'nit_norm_unico' });
