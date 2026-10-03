import { describe, it, expect } from 'vitest';
import { SecretBox } from './secret-box';

describe('SecretBox', () => {
  const llave = 'una-llave-de-prueba-suficientemente-larga-123';

  it('lo que se cierra se vuelve a abrir igual', () => {
    const box = new SecretBox(llave);

    expect(box.open(box.seal('token-de-la-empresa'))).toBe('token-de-la-empresa');
  });

  it('el valor guardado no deja ver el secreto', () => {
    const sealed = new SecretBox(llave).seal('token-de-la-empresa');

    expect(sealed).not.toContain('token');
    expect(sealed.startsWith('v1:')).toBe(true);
  });

  it('cifrar dos veces lo mismo da textos distintos', () => {
    const box = new SecretBox(llave);

    expect(box.seal('x')).not.toBe(box.seal('x'));
  });

  it('con otra llave no abre', () => {
    const sealed = new SecretBox(llave).seal('secreto');

    expect(() => new SecretBox(`${llave}-otra`).open(sealed)).toThrow();
  });

  it('si alguien altera lo guardado, lo detecta', () => {
    const box = new SecretBox(llave);
    const [v, iv, tag, enc = ''] = box.seal('secreto').split(':');
    const alterado = Buffer.from(enc, 'base64');
    alterado[0] = (alterado[0] ?? 0) ^ 1;

    expect(() =>
      box.open([v, iv, tag, alterado.toString('base64')].join(':')),
    ).toThrow();
  });

  it('rechaza una llave corta', () => {
    expect(() => new SecretBox('corta')).toThrow(/32 caracteres/);
  });
});
