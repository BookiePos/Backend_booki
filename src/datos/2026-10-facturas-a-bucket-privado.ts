import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import type { INestApplicationContext } from '@nestjs/common';
import { enCadaEmpresa } from './en-cada-empresa';
import { StorageService } from '../shared/storage/storage.service';
import {
  InvoiceScan,
  type InvoiceScanDocument,
} from '../modules/invoice-scan/infrastructure/schemas/invoice-scan.schema';

/**
 * Por qué existe (checklist 3.8): las facturas de compra subidas antes del
 * bucket privado siguen en el público, con una URL que cualquiera con el
 * enlace puede abrir. Este script copia cada página al bucket privado, la marca
 * `privada` y le quita la URL pública; después borra el archivo público. Si la
 * copia falla, la página queda como estaba y el script sigue con la siguiente.
 * Idempotente: solo toca páginas sin `privada`.
 *
 *   pnpm build
 *   node dist/datos/2026-10-facturas-a-bucket-privado.js --empresa <id>
 *   node dist/datos/2026-10-facturas-a-bucket-privado.js --empresa <id> --aplicar
 *   node dist/datos/2026-10-facturas-a-bucket-privado.js --todas
 *   node dist/datos/2026-10-facturas-a-bucket-privado.js --todas --aplicar
 */

const PUBLICAS = { pages: { $elemMatch: { privada: { $ne: true } } } };

const modelo = (app: INestApplicationContext) =>
  app.get<Model<InvoiceScanDocument>>(getModelToken(InvoiceScan.name));

void enCadaEmpresa({
  nombre: 'pasar las facturas de compra al bucket privado',
  contar: async (app) => {
    const scans = await modelo(app).find(PUBLICAS, { pages: 1 }).lean().exec();
    const paginas = scans.reduce(
      (n, s) => n + s.pages.filter((p) => !p.privada).length,
      0,
    );
    return { facturas: scans.length, paginasPublicas: paginas };
  },
  aplicar: async (app) => {
    const scans = modelo(app);
    const storage = app.get(StorageService);
    const pendientes = await scans.find(PUBLICAS, { pages: 1 }).lean().exec();
    for (const scan of pendientes) {
      for (const page of scan.pages.filter((p) => !p.privada)) {
        if (!page.imageUrl) continue;
        const res = await fetch(page.imageUrl);
        if (!res.ok) {
          console.warn(`  ${scan._id}: no se pudo bajar ${page.imagePathname} (${res.status})`);
          continue;
        }
        const tipo = res.headers.get('content-type') ?? 'image/jpeg';
        await storage.uploadPrivado(
          page.imagePathname,
          Buffer.from(await res.arrayBuffer()),
          tipo,
        );
        await scans.collection.updateOne(
          { _id: scan._id, 'pages.imagePathname': page.imagePathname },
          {
            $set: { 'pages.$.privada': true },
            $unset: { 'pages.$.imageUrl': '' },
          },
        );
        // Solo después de que la base apunta al privado se borra el público.
        await storage.remove(page.imagePathname);
      }
    }
  },
});
