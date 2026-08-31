import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { readFile, readdir } from 'fs/promises';
import { readFileSync } from 'fs';
import { extname, join, resolve } from 'path';
import { QwenExtractorService } from './modules/invoice-scan/application/qwen-extractor.service';
import { GlmExtractorService } from './modules/invoice-scan/application/glm-extractor.service';
import type { InvoiceExtractor } from './modules/invoice-scan/application/invoice-extractor';
import type { ExtractedInvoice } from './modules/invoice-scan/domain/invoice-extraction';

/**
 * Comparador de extractores de facturas ("bake-off").
 *
 * Cuál de los dos modelos lee mejor una factura colombiana arrugada NO se
 * decide leyendo benchmarks ajenos: se decide midiendo con facturas reales del
 * negocio. Este script corre los dos sobre la misma carpeta y dice, campo a
 * campo, cuál acierta más y cuánto tarda.
 *
 *   pnpm eval:facturas [carpeta]
 *
 * La carpeta lleva las imágenes y, junto a cada una, un archivo
 * `<nombre>.expected.json` con lo que DEBERÍA leerse (basta con los campos que
 * quieras medir):
 *
 *   { "supplier": { "docNumber": "900123456" },
 *     "invoice": { "number": "FV-4821" },
 *     "totals": { "total": 68800 },
 *     "lineCount": 3 }
 *
 * Sin `expected` la imagen igual se procesa: sirve para ver qué devuelve cada
 * modelo antes de anotar la respuesta correcta.
 */

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif']);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

interface Expected {
  supplier?: { docNumber?: string; name?: string };
  invoice?: { number?: string; issueDate?: string };
  totals?: { total?: number };
  lineCount?: number;
}

interface Score {
  checks: number;
  hits: number;
  ms: number;
  failures: string[];
}

/**
 * Carga el `.env` a mano.
 *
 * Los seeds del repo arrancan la app entera de Nest y con ella el ConfigModule,
 * pero eso aquí exigiría Mongo levantado para nada: este script solo habla con
 * las APIs de los modelos. Un parser de doce líneas evita esa dependencia.
 */
function loadDotEnv(): void {
  try {
    const raw = readFileSync(resolve('.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1];
      const rawValue = match[2];
      if (!key || rawValue === undefined) continue;
      // El entorno real manda: no se pisa lo que ya venga definido.
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // Sin .env se sigue con las variables del entorno, que es lo normal en CI.
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const folder = resolve(process.argv[2] ?? './facturas-eval');
  const config = new ConfigService();

  const candidates: { name: string; extractor: InvoiceExtractor }[] = [
    { name: 'qwen', extractor: new QwenExtractorService(config) },
    { name: 'glm', extractor: new GlmExtractorService(config) },
  ];
  const enabled = candidates.filter((c) => c.extractor.enabled);

  if (enabled.length === 0) {
    console.error(
      'Ningún extractor configurado. Define QWEN_API_KEY y/o ZAI_API_KEY en el .env.',
    );
    process.exit(1);
  }

  let files: string[];
  try {
    files = (await readdir(folder)).filter((f) =>
      IMAGE_EXTENSIONS.has(extname(f).toLowerCase()),
    );
  } catch {
    console.error(`No se pudo leer la carpeta ${folder}.`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`No hay imágenes en ${folder}.`);
    process.exit(1);
  }

  console.log(`\n${files.length} factura(s) en ${folder}`);
  console.log(`Modelos: ${enabled.map((c) => c.extractor.model).join(' · ')}\n`);

  const scores = new Map<string, Score>(
    enabled.map((c) => [c.name, { checks: 0, hits: 0, ms: 0, failures: [] }]),
  );

  for (const file of files) {
    const buffer = await readFile(join(folder, file));
    const mimetype = MIME_BY_EXTENSION[extname(file).toLowerCase()] ?? 'image/jpeg';
    const expected = await loadExpected(folder, file);
    console.log(`── ${file}`);

    for (const { name, extractor } of enabled) {
      const score = scores.get(name) as Score;
      try {
        const result = await extractor.extract(buffer, mimetype);
        score.ms += result.ms;
        const line = expected
          ? compare(file, result.parsed, expected, score)
          : describe(result.parsed);
        console.log(`   ${name.padEnd(5)} ${result.ms}ms  ${line}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        score.failures.push(`${file}: ${message}`);
        console.log(`   ${name.padEnd(5)} ERROR  ${message}`);
      }
    }
  }

  console.log('\n── Resultado ──');
  for (const { name, extractor } of enabled) {
    const score = scores.get(name) as Score;
    const pct = score.checks > 0 ? Math.round((score.hits / score.checks) * 100) : 0;
    console.log(
      `${name.padEnd(5)} ${extractor.model.padEnd(24)} ` +
        `aciertos ${score.hits}/${score.checks} (${pct}%) · ` +
        `${Math.round(score.ms / files.length)}ms por factura · ` +
        `${score.failures.length} fallo(s)`,
    );
    for (const failure of score.failures) console.log(`      ${failure}`);
  }
  console.log(
    '\nEl ganador se fija con INVOICE_AI_PROVIDER en el entorno del API.\n',
  );
}

/** Cuenta aciertos campo a campo contra lo esperado. */
function compare(
  file: string,
  parsed: ExtractedInvoice,
  expected: Expected,
  score: Score,
): string {
  const partes: string[] = [];
  const check = (label: string, got: unknown, want: unknown) => {
    if (want === undefined) return;
    score.checks += 1;
    const ok = String(got ?? '') === String(want);
    if (ok) score.hits += 1;
    else score.failures.push(`${file} · ${label}: esperado ${String(want)}, leído ${String(got)}`);
    partes.push(`${label}${ok ? '✓' : '✗'}`);
  };

  check('nit', parsed.supplier.docNumber, expected.supplier?.docNumber);
  check('numero', parsed.invoice.number, expected.invoice?.number);
  check('fecha', parsed.invoice.issueDate, expected.invoice?.issueDate);
  check('total', parsed.totals.total, expected.totals?.total);
  check('lineas', parsed.lines.length, expected.lineCount);
  return partes.join(' ');
}

function describe(parsed: ExtractedInvoice): string {
  return [
    `nit=${parsed.supplier.docNumber ?? '—'}`,
    `num=${parsed.invoice.number ?? '—'}`,
    `total=${parsed.totals.total ?? '—'}`,
    `lineas=${parsed.lines.length}`,
  ].join(' ');
}

async function loadExpected(
  folder: string,
  file: string,
): Promise<Expected | null> {
  const base = file.replace(/\.[^.]+$/, '');
  try {
    const raw = await readFile(join(folder, `${base}.expected.json`), 'utf8');
    return JSON.parse(raw) as Expected;
  } catch {
    return null;
  }
}

main().catch((err) => {
  console.error('Fallo la evaluación:', err);
  process.exit(1);
});
