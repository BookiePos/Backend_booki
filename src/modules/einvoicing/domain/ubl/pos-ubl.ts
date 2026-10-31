import { DocumentoUblInvalidoError, esc } from './xml-ubl';
import { formatearMontoDian } from '../redondeo';
import { armarInvoiceUbl, totalesUbl, type PerfilInvoice } from './factura-ubl';
import type { CajaVentaUbl, FabricanteSoftwareUbl, PosUbl } from './pos-ubl.types';

/**
 * Builder UBL 2.1 del documento equivalente electrónico tiquete de máquina
 * registradora con sistema P.O.S. (anexo técnico DE v1.0, Res. 000165 de 2023).
 * Es un `Invoice`, así que reutiliza el esqueleto de la factura
 * (`armarInvoiceUbl`) y solo cambia lo que el anexo cambia (§2 del anexo de la
 * Fase 7):
 *
 * - Constantes: tipo 20, operación 10, ProfileID del POS y `CUDE-SHA384`.
 * - Tres `ext:UBLExtension` más: fabricante del software, beneficios del
 *   comprador y caja de venta.
 * - `PartyIdentification` del adquiriente siempre (DEAK61-62).
 * - El correo del emisor es obligatorio (DEAJ71).
 * - `PaymentMeans` 1..N (pago mixto).
 *
 * Función pura, sin el PIN: recibe el CUDE ya calculado (`calcularCudePos`) y el
 * hash del código de seguridad del software.
 */

/**
 * 20 = documento equivalente electrónico POS (§16.3); 10 = operación normal
 * (§16.4.1). Contingencia (07/08 con `CustomizationID` 20) es de la Fase 9.
 * El ProfileID va SIN el espacio inicial que el anexo muestra a veces: así lo
 * trae el «Ejemplo POS.xml» oficial (a confirmar en habilitación).
 */
export const PERFIL_POS: PerfilInvoice = {
  documento: 'El documento POS',
  customizationId: '10',
  profileId: 'DIAN 2.1: Documento Equivalente POS',
  invoiceTypeCode: '20',
  esquemaCodigoUnico: 'CUDE-SHA384',
};

/**
 * Nombres de los grupos de cada extensión `[grupo, información]`.
 *
 * - Fabricante: igual en las reglas (DEAB37-46) y en el ejemplo oficial.
 * - Beneficios: las tablas del anexo dicen `VeneficiosComprador` /
 *   `InformacionVeneficiosComprador` (errata con V), pero la regla DEPD15-20
 *   nombra `InformacionBeneficiosComprador` y el «Ejemplo POS.xml» de la caja de
 *   herramientas v1.3 usa `BeneficiosComprador`. Se sigue el ejemplo oficial
 *   (a confirmar en habilitación; si la DIAN pide la V, se cambia SOLO aquí).
 * - Caja: `PuntoVenta` / `InformacionCajaVenta`, igual en el anexo y el ejemplo.
 */
export const EXTENSIONES_POS = {
  fabricante: ['FabricanteSoftware', 'InformacionDelFabricanteDelSoftware'],
  beneficios: ['BeneficiosComprador', 'InformacionBeneficiosComprador'],
  caja: ['PuntoVenta', 'InformacionCajaVenta'],
} as const;

/** Máximo de cada `Value` de las extensiones del POS (columna Tam del anexo). */
export const LARGO_MAXIMO_VALOR_POS = 100;

/**
 * Grupo `<grupo><info><Name/><Value/>…</info></grupo>` sin prefijo: como en el
 * ejemplo oficial, hereda el namespace por defecto del `Invoice`. Va dentro de
 * `ext:ExtensionContent` (`processContents="lax"`), así que el XSD no lo valida.
 */
function grupoNombreValor(nombres: readonly [string, string], pares: ReadonlyArray<readonly [string, string]>): string {
  const [grupo, info] = nombres;
  const cuerpo = pares
    .map(([n, v]) => `\n            <Name>${esc(n)}</Name>\n            <Value>${esc(v)}</Value>`)
    .join('');
  return `<${grupo}>
          <${info}>${cuerpo}
          </${info}>
        </${grupo}>`;
}

function exigirValor(valor: string | undefined, que: string, fallas: string[]): void {
  const v = valor?.trim() ?? '';
  if (!v) fallas.push(que);
  else if (v.length > LARGO_MAXIMO_VALOR_POS) fallas.push(`${que} (máximo ${LARGO_MAXIMO_VALOR_POS} caracteres)`);
}

/** Lo que el POS exige además de la factura. Lanza con la lista de lo que falta. */
export function faltantesPos(p: Pick<PosUbl, 'cajaVenta' | 'fabricante' | 'emisor' | 'pagos'>): string[] {
  const fallas: string[] = [];
  const c: Partial<CajaVentaUbl> = p.cajaVenta ?? {};
  exigirValor(c.placa, 'placa de la caja', fallas);
  exigirValor(c.ubicacion, 'ubicación de la caja', fallas);
  exigirValor(c.tipo, 'tipo de caja', fallas);
  exigirValor(c.cajero, 'cajero', fallas);
  exigirValor(c.codigoVenta, 'código de la venta', fallas);
  const f: Partial<FabricanteSoftwareUbl> = p.fabricante ?? {};
  exigirValor(f.nombreApellido, 'nombre del fabricante del software', fallas);
  exigirValor(f.nombreSoftware, 'nombre del software', fallas);
  if (f.razonSocial !== undefined && f.razonSocial.trim()) exigirValor(f.razonSocial, 'razón social del fabricante', fallas);
  if (!p.emisor?.email?.trim()) fallas.push('correo del emisor');
  if (!Array.isArray(p.pagos) || p.pagos.length === 0) fallas.push('medios de pago');
  else
    p.pagos.forEach((pago, i) => {
      // DEAN04: el vencimiento es obligatorio en el pago a crédito.
      if (pago.formaPago === '2' && !pago.vence) fallas.push(`vencimiento del pago ${i + 1} (a crédito)`);
    });
  return fallas;
}

/** XML UBL 2.1 del documento equivalente POS, SIN firmar. Lanza `DocumentoUblInvalidoError` si algo no cuadra. */
export function armarPosUbl(p: PosUbl): string {
  const fallas = faltantesPos(p);
  if (fallas.length > 0) {
    throw new DocumentoUblInvalidoError(`El documento POS no se puede armar; revisa: ${fallas.join(', ')}`);
  }
  const t = totalesUbl(p.lineas, p.cargos);
  const f = p.fabricante;
  const razon = f.razonSocial?.trim();
  const fabricante = grupoNombreValor(EXTENSIONES_POS.fabricante, [
    ['NombreApellido', f.nombreApellido.trim()],
    ...(razon ? ([['RazonSocial', razon]] as const) : []),
    ['NombreSoftware', f.nombreSoftware.trim()],
  ]);
  // Sin programa de puntos: el comprador se informa con 0 puntos (§10.2.1.1 lo exige).
  const beneficios = grupoNombreValor(EXTENSIONES_POS.beneficios, [
    ['Codigo', p.adquiriente.numero],
    ['NombresApellidos', p.adquiriente.nombre],
    ['Puntos', '0'],
  ]);
  const c = p.cajaVenta;
  // Literales con tilde, como las reglas DEPD27 y DEPD35 y el ejemplo oficial.
  const caja = grupoNombreValor(EXTENSIONES_POS.caja, [
    ['PlacaCaja', c.placa.trim()],
    ['UbicaciónCaja', c.ubicacion.trim()],
    ['Cajero', c.cajero.trim()],
    ['TipoCaja', c.tipo.trim()],
    ['CódigoVenta', c.codigoVenta.trim()],
    ['SubTotal', formatearMontoDian(t.lineExtension)],
  ]);
  return armarInvoiceUbl(p, {
    perfil: PERFIL_POS,
    pagos: p.pagos,
    extensionesExtra: [fabricante, beneficios, caja],
    identificacionAdquirienteSiempre: true,
  });
}
