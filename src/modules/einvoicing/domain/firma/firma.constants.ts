/**
 * Constantes de la firma XAdES-EPES de los documentos electrónicos de la DIAN.
 *
 * Fuentes (consultadas el 2026-10-30):
 * - Anexo técnico de factura electrónica de venta v1.9 (Res. 000165 de 2023), §6.10
 *   «Firma digital del documento: ds:Signature» (DC01–DC56).
 *   https://cdn.actualicese.com/normatividad/2023/Resoluciones/Anexo-1-R165-23.pdf
 * - Política de firma de los documentos electrónicos, versión 2 (anexo 2 de la
 *   Res. 000019 de 2016), §7 (canon), §8 (ubicación), §9 (referencias), §10.2
 *   (identificador de la política sha-2), §12 (firmante) y Reglas 3 y 4 (algoritmos).
 *   https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf
 * - Anexo técnico de nómina electrónica v1.0 (Res. 000013 de 2021), §7.9: ejemplo
 *   de `SignedInfo` con SHA-256 (sin `Transforms` en las referencias a KeyInfo y
 *   SignedProperties) y los ids `xmldsig-{uuid}-ref0|keyinfo|signedprops`.
 */

export const NS_DS = 'http://www.w3.org/2000/09/xmldsig#';
export const NS_XADES = 'http://uri.etsi.org/01903/v1.3.2#';
export const NS_XADES141 = 'http://uri.etsi.org/01903/v1.4.1#';
export const NS_EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';

/**
 * Canon de `SignedInfo`: Canonical XML 1.0 sin comentarios (anexo v1.9 DC03 y
 * política v2 §7). Es el INCLUSIVO; la DIAN no pide exc-c14n.
 */
export const ALG_C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';

/** RSA-SHA256 (anexo v1.9 DC04; política v2 Regla-3). */
export const ALG_FIRMA_RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';

/**
 * Resumen SHA-256 de las referencias, de `CertDigest` y de `SigPolicyHash`
 * (política v2 Regla-4). Ojo: las tablas del anexo v1.9 (DC08, DC11, DC14, DC28…)
 * listan por errata las URIs de `SignatureMethod` (`xmldsig-more#rsa-sha256`) como
 * `DigestMethod`; la política y el ejemplo del anexo de nómina usan `xmlenc#sha256`.
 */
export const ALG_RESUMEN_SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

/** Transformada de la primera referencia (anexo v1.9 DC07). */
export const ALG_ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';

/** `Type` de la referencia a `SignedProperties` (política v2 §9). */
export const TIPO_REF_SIGNED_PROPERTIES = 'http://uri.etsi.org/01903#SignedProperties';

/** Política de firma DIAN v2 (política v2 §10.2, opción sha-2; anexo v1.9 DC50–DC53). */
export const POLITICA_FIRMA_DIAN = Object.freeze({
  identificador: 'https://facturaelectronica.dian.gov.co/politicadefirma/v2/politicadefirmav2.pdf',
  algoritmoResumen: ALG_RESUMEN_SHA256,
  /**
   * SHA-256 en base64 del PDF publicado en `identificador`. Ningún anexo imprime
   * este valor: se calculó sobre el PDF oficial descargado el 2026-10-30 (1 272 898
   * bytes, 42 páginas). Si la DIAN republica el PDF, este valor cambia.
   */
  resumen: 'dMoMvtcG5aIzgYo0tIsSQeVJBDnUnfSOfBpxXrmor0Y=',
});

/**
 * `ClaimedRole` (política v2 §12): `supplier` cuando firma el obligado a facturar
 * con su propio certificado (la vía directa de BookiPos); `third party` cuando
 * firma un proveedor tecnológico en su nombre.
 */
export type RolFirmante = 'supplier' | 'third party';
export const ROL_FIRMANTE_EMISOR: RolFirmante = 'supplier';

/** Colombia no tiene horario de verano: la hora legal es siempre UTC−05:00. */
export const ZONA_HORARIA_COLOMBIA = '-05:00';
