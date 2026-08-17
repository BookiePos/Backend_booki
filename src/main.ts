import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

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
  app.enableCors({
    origin: corsOrigins,
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
