import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { cadenaCune, calcularCune, calcularCuneEliminar, type DatosCune } from './cune';

/**
 * Ejemplo del anexo técnico de nómina electrónica v1.0 (Res. 000013 de 2021),
 * §8.1.1.3. El anexo imprime la composición con una errata («2020-01-161053:10»,
 * sin los dos puntos de la hora) y su CUNE publicado (16560dc8…) no sale ni de esa
 * composición ni de la corregida. Por eso aquí se fija la composición que dicta la
 * fórmula del §8.1.1.1 y el hash se compara contra SHA-384 de ella; no hay un
 * vector oficial reproducible para el hash del CUNE.
 */
const ANEXO: DatosCune = {
  numero: 'N00001',
  fecha: '2020-01-16',
  hora: '10:53:10-05:00',
  devengados: 350000000,
  deducciones: 100000000,
  total: 250000000,
  nitEmpleador: '700085371',
  docEmpleado: '800199436',
  tipoXml: '102',
  softwarePin: '693',
  tipoAmbiente: '1',
};

const sha384 = (s: string) => createHash('sha384').update(s, 'utf8').digest('hex');

describe('CUNE (anexo de nómina 1.0, §8.1.1)', () => {
  it('la composición del ejemplo del anexo, en el orden de la fórmula', () => {
    expect(cadenaCune(ANEXO)).toBe(
      'N000012020-01-1610:53:10-05:003500000.001000000.002500000.007000853718001994361026931',
    );
    expect(calcularCune(ANEXO)).toBe(sha384(cadenaCune(ANEXO)));
  });

  it('el ambiente y el PIN cambian el CUNE', () => {
    expect(calcularCune({ ...ANEXO, tipoAmbiente: '2' })).not.toBe(calcularCune(ANEXO));
    expect(calcularCune({ ...ANEXO, softwarePin: '694' })).not.toBe(calcularCune(ANEXO));
  });

  it('Eliminar: totales 0.00, DocEmp 0 y TipoXML 103 (§8.1.1.4)', () => {
    const { numero, fecha, hora, nitEmpleador, softwarePin, tipoAmbiente } = ANEXO;
    const cadena = cadenaCune({
      ...ANEXO,
      devengados: 0,
      deducciones: 0,
      total: 0,
      docEmpleado: '0',
      tipoXml: '103',
    });
    expect(cadena).toBe('N000012020-01-1610:53:10-05:000.000.000.0070008537101036931');
    expect(calcularCuneEliminar({ numero, fecha, hora, nitEmpleador, softwarePin, tipoAmbiente })).toBe(
      sha384(cadena),
    );
  });

  it('valida PIN, NIT, ambiente y que el total sea devengados − deducciones', () => {
    expect(() => cadenaCune({ ...ANEXO, softwarePin: '  ' })).toThrow(/PIN/);
    expect(() => cadenaCune({ ...ANEXO, nitEmpleador: '700085371-1' })).toThrow(/sin DV/);
    expect(() => cadenaCune({ ...ANEXO, tipoAmbiente: '3' as never })).toThrow(/ambiente/);
    expect(() => cadenaCune({ ...ANEXO, total: 250000001 })).toThrow(/devengados − deducciones/);
    expect(() => cadenaCune({ ...ANEXO, deducciones: 400000000, total: -50000000 })).toThrow(
      /no puede ser negativo/,
    );
    expect(() => cadenaCune({ ...ANEXO, fecha: '2020-1-16' })).toThrow(/Fecha inválida/);
    expect(() => cadenaCune({ ...ANEXO, hora: '10:53-05:00' })).toThrow(/Hora inválida/);
  });
});
