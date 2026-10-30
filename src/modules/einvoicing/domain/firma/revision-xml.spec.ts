import { describe, expect, it } from 'vitest';
import { atributoConControl, traeDoctype } from './revision-xml';

describe('atributoConControl', () => {
  it('encuentra el atributo con tab, salto de línea o retorno de carro', () => {
    expect(atributoConControl('<a x="1" y="2\t3"/>')).toBe('y');
    expect(atributoConControl("<a b = 'x\ny'/>")).toBe('b');
    expect(atributoConControl('<a><b c="\r"></b></a>')).toBe('c');
  });

  it('ignora texto, comentarios, CDATA e instrucciones de procesamiento', () => {
    expect(
      atributoConControl('<?xml version="1.0"?><a x="1">texto\tcon="tab\t"<!-- c="\t" --><![CDATA[ d="\n" ]]></a>'),
    ).toBeNull();
    expect(atributoConControl('<a x="1>2" y="ok"/>')).toBeNull();
  });
});

describe('traeDoctype', () => {
  it('detecta DOCTYPE sin importar mayúsculas', () => {
    expect(traeDoctype('<!doctype a><a/>')).toBe(true);
    expect(traeDoctype('<a/>')).toBe(false);
  });
});
