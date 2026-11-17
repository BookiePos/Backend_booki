import { MUNICIPIOS_DANE } from './municipios-dane.datos';

export interface MunicipioDane {
  /** Código DANE de 5 dígitos (los 2 primeros son el departamento). */
  codigo: string;
  municipio: string;
  departamento: string;
}

const POR_CODIGO = new Map<string, MunicipioDane>(
  MUNICIPIOS_DANE.map(([codigo, municipio, departamento]) => [codigo, { codigo, municipio, departamento }]),
);

/** Todos, ordenados por código. Para la lista de la pantalla. */
export function listarMunicipiosDane(): MunicipioDane[] {
  return [...POR_CODIGO.values()];
}

export function municipioPorCodigo(codigo?: string | null): MunicipioDane | undefined {
  return codigo ? POR_CODIGO.get(codigo.trim()) : undefined;
}

/** Sin tildes, mayúsculas, signos ni espacios de más: «Bogotá, D.C.» = «bogota dc». */
function clave(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nombres que la gente escribe distinto al DANE. */
const ALIAS_MUNICIPIO: Readonly<Record<string, string>> = {
  bogota: '11001',
  'bogota d c': '11001',
  cali: '76001',
  cartagena: '13001',
  'santa marta': '47001',
  cucuta: '54001',
};

/**
 * Código DANE a partir de lo que la sede tiene en texto (departamento y
 * ciudad). Solo devuelve un código cuando no hay duda: el nombre coincide con
 * UN municipio del departamento escrito (o, sin departamento, con uno solo en
 * todo el país). Si hay dos «San Antonio» y no se sabe cuál, no adivina.
 */
export function municipioDesdeTexto(
  departamento?: string | null,
  ciudad?: string | null,
): MunicipioDane | undefined {
  const c = ciudad ? clave(ciudad) : '';
  if (!c) return undefined;
  const d = departamento ? clave(departamento) : '';
  const alias = ALIAS_MUNICIPIO[c];
  if (alias) {
    const m = POR_CODIGO.get(alias);
    // Bogotá es su propio «departamento» en el DANE, pero mucha gente escribe
    // Cundinamarca: para ella el departamento no se exige.
    const deptoOk = !d || alias === '11001' || clave(m?.departamento ?? '').includes(d) || d.includes(clave(m?.departamento ?? ''));
    if (m && deptoOk) return m;
  }
  const candidatos = listarMunicipiosDane().filter((m) => clave(m.municipio) === c);
  const delDepto = d
    ? candidatos.filter((m) => {
        const md = clave(m.departamento);
        return md === d || md.includes(d) || d.includes(md);
      })
    : candidatos;
  return delDepto.length === 1 ? delDepto[0] : undefined;
}
