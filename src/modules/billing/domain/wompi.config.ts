import { ConfigService } from '@nestjs/config';

/** Configuración de Wompi resuelta desde variables de entorno. */
export interface WompiConfig {
  environment: 'sandbox' | 'production';
  baseUrl: string;
  publicKey: string;
  privateKey: string;
  integritySecret: string;
  eventsSecret: string;
}

/**
 * Lee la config de Wompi del entorno. Por defecto apunta al SANDBOX. Las llaves
 * (pública, privada, secreto de integridad, secreto de eventos) se toman de:
 *   WOMPI_ENV=sandbox|production
 *   WOMPI_BASE_URL (opcional; se deriva del ambiente si falta)
 *   WOMPI_PUBLIC_KEY / WOMPI_PRIVATE_KEY
 *   WOMPI_INTEGRITY_SECRET / WOMPI_EVENTS_SECRET
 * Si faltan las llaves, `isConfigured()` devuelve false y el servicio responde
 * un error claro en vez de llamar a Wompi con credenciales vacías.
 */
export function wompiConfig(config: ConfigService): WompiConfig {
  const environment =
    config.get<string>('WOMPI_ENV') === 'production' ? 'production' : 'sandbox';
  const baseUrl =
    config.get<string>('WOMPI_BASE_URL') ??
    (environment === 'production'
      ? 'https://production.wompi.co/v1'
      : 'https://sandbox.wompi.co/v1');
  return {
    environment,
    baseUrl,
    publicKey: config.get<string>('WOMPI_PUBLIC_KEY') ?? '',
    privateKey: config.get<string>('WOMPI_PRIVATE_KEY') ?? '',
    integritySecret: config.get<string>('WOMPI_INTEGRITY_SECRET') ?? '',
    eventsSecret: config.get<string>('WOMPI_EVENTS_SECRET') ?? '',
  };
}

export function isWompiConfigured(cfg: WompiConfig): boolean {
  return Boolean(
    cfg.publicKey && cfg.privateKey && cfg.integritySecret && cfg.eventsSecret,
  );
}
