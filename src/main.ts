import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  // CORS para los frontends: panel admin (:3000) y POS de trabajadores (:3002).
  // CORS_ORIGIN admite varios orígenes separados por coma.
  const corsOrigins = (
    process.env.CORS_ORIGIN ?? 'http://localhost:3000,http://localhost:3002'
  )
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
