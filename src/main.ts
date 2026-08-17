import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // Confiamos en UN salto de reverse proxy (Nginx/ingress/etc.) para que
  // Express derive `req.ip` del primer valor de X-Forwarded-For puesto por el
  // proxy y no de headers arbitrarios del cliente. Los consumidores (p. ej. la
  // auditoría) usan `req.ip` en vez de leer el header a mano, evitando IP
  // falseada. Si no hay proxy, `req.ip` cae a la IP del socket (también segura).
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Cabeceras de seguridad HTTP (helmet) antes de cualquier ruta. Es una API
  // JSON (no sirve HTML propio), así que la CSP por defecto no aplica a un
  // frontend externo; se dejan los valores por defecto de helmet.
  app.use(helmet());

  // Lee cookies (el refresh token viaja como cookie HttpOnly). Necesario antes
  // de los controladores que leen req.cookies.
  app.use(cookieParser());

  // Un solo frontend: la app unificada de GoCheck en :3000 sirve la web
  // pública, el panel (/panel) y el punto de venta (/pos). Al compartir
  // origen, ya no hay preflight entre zonas.
  // CORS_ORIGIN admite varios orígenes separados por coma (útil si se levantan
  // las apps antiguas en 3002/3003 para comparar).
  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  // En producción no deben permitirse orígenes localhost/http (inseguros o de
  // desarrollo): se filtran y se advierte claramente. En desarrollo se
  // conserva el comportamiento actual sin cambios.
  const isProd = process.env.NODE_ENV === 'production';
  const safeOrigins = isProd
    ? corsOrigins.filter((o) => {
        const insecure = /^http:\/\//i.test(o) || /localhost|127\.0\.0\.1/i.test(o);
        if (insecure) {
          logger.warn(
            `CORS: origen "${o}" ignorado en producción (localhost o http inseguro). ` +
              'Configura CORS_ORIGIN con dominios https públicos.',
          );
        }
        return !insecure;
      })
    : corsOrigins;
  app.enableCors({
    origin: safeOrigins,
    credentials: true,
  });

  // Validación global de DTOs (class-validator)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.PORT ?? 3001);
  await app.listen(port);
  logger.log(`Sistema POS backend escuchando en http://localhost:${port}`);
  logger.log(`Health check: http://localhost:${port}/health`);
}

bootstrap().catch((err) => {
  // No crashea silenciosamente: log claro del fallo de arranque.
  // eslint-disable-next-line no-console
  console.error('Fallo al arrancar el backend:', err);
  process.exit(1);
});
