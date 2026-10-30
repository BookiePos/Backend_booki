import { createHash } from 'crypto';
import * as forge from 'node-forge';
import {
  nombreRfc4514,
  type AtributoNombre,
  type CertificadoFirmante,
} from '../../domain/firma/propiedades-firmadas';

/**
 * Error de la firma. El mensaje es siempre fijo: nunca lleva la contraseña, la
 * llave ni el texto del error de node-forge (que podría citar contenido del .p12).
 */
export class ErrorFirma extends Error {
  constructor(
    readonly codigo:
      | 'p12_ilegible'
      | 'p12_sin_llave'
      | 'p12_sin_certificado'
      | 'p12_llave_no_rsa'
      | 'xml_invalido'
      | 'sin_ranura'
      | 'ya_firmado',
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorFirma';
  }
}

/** Lo que la firma necesita del .p12. Vive solo en memoria. */
export interface MaterialFirma {
  llavePem: string;
  /** Certificado del firmante en PEM (para la verificación local). */
  certificadoPem: string;
  /** DER del certificado del firmante en base64, sin saltos (para `ds:X509Certificate`). */
  certificadoB64: string;
  /** Firmante, intermedias y raíz, en ese orden. */
  cadena: CertificadoFirmante[];
}

// Los tipos de node-forge declaran `oids` como diccionario abierto (string | undefined).
const OID_LLAVE_CIFRADA = forge.pki.oids.pkcs8ShroudedKeyBag as string;
const OID_LLAVE = forge.pki.oids.keyBag as string;
const OID_CERT = forge.pki.oids.certBag as string;

export function abrirP12(p12: Buffer, password: string): MaterialFirma {
  let contenedor: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(p12.toString('binary')));
    contenedor = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch {
    throw new ErrorFirma(
      'p12_ilegible',
      'No se pudo abrir el certificado: la contraseña no corresponde o el archivo no es un .p12 válido',
    );
  }

  const llaves = [
    ...(contenedor.getBags({ bagType: OID_LLAVE_CIFRADA })[OID_LLAVE_CIFRADA] ?? []),
    ...(contenedor.getBags({ bagType: OID_LLAVE })[OID_LLAVE] ?? []),
  ].filter((b) => b.key);
  if (llaves.length !== 1) {
    throw new ErrorFirma('p12_sin_llave', 'El certificado debe traer exactamente una llave privada');
  }
  const llave = llaves[0]!.key as forge.pki.rsa.PrivateKey;
  if (!llave.n || !llave.e) {
    throw new ErrorFirma('p12_llave_no_rsa', 'La llave del certificado no es RSA');
  }

  const certs = (contenedor.getBags({ bagType: OID_CERT })[OID_CERT] ?? [])
    .map((b: forge.pkcs12.Bag) => b.cert)
    .filter((c): c is forge.pki.Certificate => Boolean(c));
  const firmante = certs.find((c: forge.pki.Certificate) => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey;
    return Boolean(pub.n) && pub.n.equals(llave.n) && pub.e.equals(llave.e);
  });
  if (!firmante) {
    throw new ErrorFirma('p12_sin_certificado', 'El .p12 no trae el certificado de su llave privada');
  }

  return {
    llavePem: forge.pki.privateKeyToPem(llave),
    certificadoPem: forge.pki.certificateToPem(firmante),
    certificadoB64: forge.util.encode64(derDe(firmante)),
    cadena: ordenarCadena(firmante, certs).map(aFirmante),
  };
}

function derDe(cert: forge.pki.Certificate): string {
  return forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
}

/** Sube del firmante a la raíz con lo que trae el .p12; se detiene si falta un eslabón. */
function ordenarCadena(
  firmante: forge.pki.Certificate,
  todos: forge.pki.Certificate[],
): forge.pki.Certificate[] {
  const cadena = [firmante];
  let actual = firmante;
  while (!esAutofirmado(actual) && cadena.length <= todos.length) {
    const padre = todos.find((c) => !cadena.includes(c) && emitio(c, actual));
    if (!padre) break;
    cadena.push(padre);
    actual = padre;
  }
  return cadena;
}

function emitio(padre: forge.pki.Certificate, hijo: forge.pki.Certificate): boolean {
  try {
    return padre.verify(hijo);
  } catch {
    return false;
  }
}

function esAutofirmado(c: forge.pki.Certificate): boolean {
  return c.issuer.hash === c.subject.hash && emitio(c, c);
}

function aFirmante(cert: forge.pki.Certificate): CertificadoFirmante {
  const atributos: AtributoNombre[] = cert.issuer.attributes.map((a) => ({
    tipo: a.shortName ?? a.type ?? '',
    valor: String(a.value ?? ''),
  }));
  return {
    resumenB64: createHash('sha256').update(Buffer.from(derDe(cert), 'binary')).digest('base64'),
    emisor: nombreRfc4514(atributos),
    serialDecimal: BigInt(`0x${cert.serialNumber}`).toString(10),
  };
}
