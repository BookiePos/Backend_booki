import { describe, it, expect, vi, afterEach } from 'vitest';
import { GlmExtractorService } from './glm-extractor.service';

/**
 * Qué texto le llega al segundo paso después del OCR.
 *
 * La respuesta de GLM-OCR trae `id` y `request_id` (cadenas de 30 caracteres)
 * ANTES de `md_results`. El recolector se quedaba con la primera cadena larga,
 * así que el modelo de texto recibía el id de la petición en vez de la factura
 * y devolvía `{}`: ninguna foto se leía. La forma de abajo es la de una
 * respuesta real guardada en producción (factura de Comercial Nutresa).
 */
describe('GlmExtractorService · texto del OCR para el segundo paso', () => {
  const MARKDOWN = [
    '# COMERCIAL NUTRESA S.A.S',
    'NIT: 900341086-0',
    'CODIGO DESCRIPCION CANT PRECIO TOTAL',
    '1059178 Cober SCH Cordi 7 37337 261362',
    '1059257 Cober SCH Cordi 16 42769 684298',
    'TOTAL UND 23 SUBTOTAL : 945.660',
  ].join('\n\n');

  const ocrResponse = {
    created: 1789420123,
    data_info: { num_pages: 1, pages: [{ width: 406, height: 1280 }] },
    id: '2026091505084406ae8d494ad34fa6',
    layout_details: [[{ label: 'text', content: 'COMERCIAL NUTRESA S.A.S' }]],
    layout_visualization: [],
    md_results: MARKDOWN,
    model: 'GLM-OCR',
    request_id: '2026091505084406ae8d494ad34fa6',
    usage: { completion_tokens: 467, prompt_tokens: 1357, total_tokens: 1824 },
  };

  const chatResponse = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            supplier: { name: 'COMERCIAL NUTRESA S.A.S', docNumber: '900341086' },
            lines: [
              { description: 'Cober SCH Cordi', qty: '7', unitCost: '37337', lineTotal: '261362' },
              { description: 'Cober SCH Cordi', qty: '16', unitCost: '42769', lineTotal: '684298' },
            ],
            totals: { total: '945.660' },
          }),
        },
      },
    ],
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeService() {
    const values: Record<string, string> = { ZAI_API_KEY: 'llave-de-prueba' };
    const config = { get: (key: string) => values[key] };
    return new GlmExtractorService(config as never);
  }

  it('manda md_results al modelo de texto, no el id de la petición', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(ocrResponse), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(chatResponse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeService().extract(Buffer.from('foto'), 'image/jpeg');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const chatBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const userMessage = chatBody.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('Cober SCH Cordi 16 42769 684298');
    expect(userMessage).not.toContain(ocrResponse.id);

    expect(result.parsed.supplier.name).toBe('COMERCIAL NUTRESA S.A.S');
    expect(result.parsed.lines).toHaveLength(2);
    expect(result.parsed.totals.total).toBe(945660);
  });

  it('sin md_results sigue encontrando el texto del documento, no los metadatos', async () => {
    const { md_results: _omitido, ...sinMarkdown } = ocrResponse;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(sinMarkdown), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(chatResponse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await makeService().extract(Buffer.from('foto'), 'image/jpeg');

    const chatBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: { role: string; content: string }[];
    };
    const userMessage = chatBody.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMessage).toContain('COMERCIAL NUTRESA S.A.S');
    expect(userMessage).not.toContain(ocrResponse.id);
  });
});
