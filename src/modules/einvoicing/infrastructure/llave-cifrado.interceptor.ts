import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { assertLlaveDeCifrado } from '../application/certificado-emisor.service';

/**
 * Corta la carga del certificado con 503 si falta `EINVOICING_ENCRYPTION_KEY`,
 * antes de que multer lea el archivo: sin llave no hay dónde guardar la
 * contraseña y el .p12 no se debe recibir. Va delante del `FileInterceptor`.
 */
@Injectable()
export class LlaveCifradoInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    assertLlaveDeCifrado();
    return next.handle();
  }
}
