import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { BusinessService } from '../../control/application/business.service';
import { DirectoryService } from '../../control/application/directory.service';
import { CONTROL_CONNECTION } from '../../control/domain/control.constants';
import {
  RegistroPendiente,
  RegistroPendienteDocument,
} from '../../control/infrastructure/schemas/registro-pendiente.schema';
import { SedesService } from '../../sedes/application/sedes.service';
import { ROLES } from '../domain/roles';
import { RegisterDto } from './dto/register.dto';
import { AuthService, AuthTokens, AuthUserView } from './auth.service';
import { MailResult, MailService } from './mail.service';
import { RolesService } from './roles.service';
import { BCRYPT_ROUNDS, UsersService } from './users.service';

/** Horas de validez del enlace de confirmación. */
const CONFIRMACION_HORAS = 24;

/** Espera mínima entre dos correos de registro al mismo buzón. */
const ENFRIAMIENTO_MS = 60_000;

/** Correos de registro por buzón en una ventana de 24 h. */
const ENVIOS_POR_DIA = 5;
const DIA_MS = 86_400_000;

/** Tiempo tras el cual una marca `consumiendoAt` colgada deja de bloquear. */
const CONSUMO_VENCE_MS = 5 * 60_000;

/** Lo que responde `POST /auth/register`, exista o no el correo. */
export const RESPUESTA_REGISTRO = {
  ok: true,
  message:
    'Te enviamos un correo para confirmar tu dirección. Abre el enlace para ' +
    'terminar de crear tu cuenta.',
} as const;

type DatosRegistro = Omit<RegisterDto, 'password'>;

/**
 * Alta de una empresa nueva (tenant) desde la web pública.
 *
 * Va en dos pasos desde el ítem 4.11. `solicitar()` responde lo mismo exista o
 * no el correo —antes un 409 «El correo ya está registrado» servía para
 * averiguar qué correos tienen cuenta— y la diferencia solo llega al buzón:
 * un enlace de confirmación si el correo es nuevo, o un aviso de «ya tienes
 * cuenta» si no. `confirmar()` crea la empresa cuando el dueño abre el enlace,
 * con lo que de paso queda probado que el correo es suyo.
 *
 * La empresa se provisiona como antes: registro en el control-plane y luego,
 * dentro de su contexto, roles de sistema, primera sede con los datos fiscales
 * y usuario Dueño.
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger('RegistrationService');

  constructor(
    private readonly businesses: BusinessService,
    private readonly directory: DirectoryService,
    private readonly roles: RolesService,
    private readonly sedes: SedesService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    @InjectModel(RegistroPendiente.name, CONTROL_CONNECTION)
    private readonly pendientes: Model<RegistroPendienteDocument>,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Primer paso. Nunca revela si el correo existe: el controlador responde
   * `RESPUESTA_REGISTRO` en todos los casos y los dos caminos hacen el mismo
   * trabajo caro (un bcrypt y un correo). Si el correo no puede salir, los dos
   * caminos fallan igual con un 503 (no hay oráculo) y el pendiente se queda.
   */
  async solicitar(dto: RegisterDto): Promise<void> {
    const email = dto.ownerEmail.toLowerCase().trim();
    // Se hashea siempre, también si el correo ya existe: así los dos caminos
    // tardan lo mismo y el tiempo de respuesta no delata la cuenta.
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Antiflood: un correo por buzón por minuto, pase lo que pase. Sin esto se
    // podía llenar un buzón ajeno desde muchas IPs.
    const reciente = await this.pendientes
      .findOne({
        email,
        ultimoEnvioAt: { $gt: new Date(Date.now() - ENFRIAMIENTO_MS) },
      })
      .exec();
    if (reciente) return;

    if (await this.directory.exists(email)) {
      await this.pendientes.deleteMany({ email, tipo: 'aviso' }).exec();
      await this.pendientes.create({
        email,
        tipo: 'aviso',
        ultimoEnvioAt: new Date(),
        expiresAt: new Date(Date.now() + ENFRIAMIENTO_MS),
      });
      const result = await this.mail.sendAvisoCuentaExistente({
        to: email,
        loginUrl: `${this.appUrl()}/login`,
        recoverUrl: `${this.appUrl()}/recuperar`,
      });
      this.exigirEnviado(result, email);
      return;
    }

    const previo = await this.pendientes
      .findOne({ email, tipo: 'confirmacion' })
      .exec();
    const ventana = ventanaDeEnvios(previo);
    if (ventana.envios >= ENVIOS_POR_DIA) return;

    // Un solo enlace vivo por correo: pedir otro reemplaza el token anterior
    // (el índice único parcial por correo lo garantiza aunque haya carreras).
    const rawToken = randomBytes(32).toString('hex');
    const { password: _omitida, ...datos } = dto;
    void _omitida;
    try {
      await this.pendientes
        .findOneAndUpdate(
          { email, tipo: 'confirmacion' },
          {
            $set: {
              tokenHash: hashToken(rawToken),
              datos: { ...datos, ownerEmail: email },
              passwordHash,
              expiresAt: new Date(Date.now() + CONFIRMACION_HORAS * 3_600_000),
              ultimoEnvioAt: new Date(),
              envios: ventana.envios + 1,
              envioDiaInicio: ventana.inicio,
            },
            $unset: { consumiendoAt: 1 },
          },
          { upsert: true },
        )
        .exec();
    } catch (err) {
      // Otra solicitud del mismo correo ganó la carrera: ya hay un enlace vivo.
      if ((err as { code?: number }).code === 11000) return;
      throw err;
    }
    const result = await this.mail.sendConfirmacionRegistro({
      to: email,
      confirmUrl: `${this.appUrl()}/registro/confirmar/${rawToken}`,
      businessName: dto.businessName,
      expiresHours: CONFIRMACION_HORAS,
    });
    this.exigirEnviado(result, email);
  }

  /**
   * Reenvía el correo de confirmación con un token nuevo; el anterior deja de
   * valer. No revela si hay un registro pendiente: sin pendiente, o dentro de
   * los límites (1 por minuto y 5 por día por buzón), no hace nada.
   */
  async reenviar(rawEmail: string): Promise<void> {
    const email = rawEmail.toLowerCase().trim();
    const ahora = Date.now();
    const pendiente = await this.pendientes
      .findOne({
        email,
        tipo: 'confirmacion',
        expiresAt: { $gt: new Date(ahora) },
      })
      .exec();
    if (!pendiente?.datos || !pendiente.tokenHash) return;
    if (
      pendiente.consumiendoAt &&
      pendiente.consumiendoAt.getTime() > ahora - CONSUMO_VENCE_MS
    ) {
      return;
    }
    if (
      pendiente.ultimoEnvioAt &&
      pendiente.ultimoEnvioAt.getTime() > ahora - ENFRIAMIENTO_MS
    ) {
      return;
    }
    const ventana = ventanaDeEnvios(pendiente);
    if (ventana.envios >= ENVIOS_POR_DIA) return;

    const rawToken = randomBytes(32).toString('hex');
    // Condicionado al token que leímos: dos reenvíos a la vez no dejan dos
    // enlaces vivos, solo gana el primero.
    const actualizado = await this.pendientes
      .findOneAndUpdate(
        { _id: pendiente._id, tokenHash: pendiente.tokenHash },
        {
          $set: {
            tokenHash: hashToken(rawToken),
            ultimoEnvioAt: new Date(ahora),
            envios: ventana.envios + 1,
            envioDiaInicio: ventana.inicio,
          },
        },
      )
      .exec();
    if (!actualizado) return;

    const horas = Math.max(
      1,
      Math.ceil((pendiente.expiresAt.getTime() - ahora) / 3_600_000),
    );
    const result = await this.mail.sendConfirmacionRegistro({
      to: email,
      confirmUrl: `${this.appUrl()}/registro/confirmar/${rawToken}`,
      businessName: String(pendiente.datos.businessName ?? ''),
      expiresHours: Math.min(horas, CONFIRMACION_HORAS),
    });
    this.exigirEnviado(result, email);
  }

  /**
   * Segundo paso: el dueño abrió el enlace. Reclama el pendiente de forma
   * atómica (un enlace crea una sola empresa aunque se abra dos veces a la
   * vez) con una marca que vence, y solo lo borra cuando la empresa quedó
   * creada. Si algo falla se deshace la empresa a medias y se suelta la marca,
   * para que el dueño pueda reintentar con el mismo enlace.
   */
  async confirmar(
    rawToken: string,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView; plan: string }> {
    const ahora = new Date();
    const tokenHash = hashToken(rawToken);
    const pendiente = await this.pendientes
      .findOneAndUpdate(
        {
          tokenHash,
          tipo: 'confirmacion',
          expiresAt: { $gt: ahora },
          $or: [
            { consumiendoAt: { $exists: false } },
            { consumiendoAt: null },
            {
              consumiendoAt: {
                $lt: new Date(ahora.getTime() - CONSUMO_VENCE_MS),
              },
            },
          ],
        },
        { $set: { consumiendoAt: ahora } },
        { new: true },
      )
      .exec();
    if (!pendiente?.datos || !pendiente.passwordHash) {
      throw new NotFoundException(
        'El enlace de confirmación no es válido o ya venció. Vuelve a registrarte.',
      );
    }
    const datos = pendiente.datos as unknown as DatosRegistro;
    const email = pendiente.email;

    try {
      // Quien llega aquí ya probó que el buzón es suyo: a él sí se le puede
      // decir que el correo o el NIT se ocuparon mientras confirmaba.
      if (await this.directory.exists(email)) {
        throw new ConflictException(
          'Ya existe una cuenta con este correo. Inicia sesión o recupera tu contraseña.',
        );
      }
      if (datos.nit && (await this.businesses.nitExists(datos.nit))) {
        throw new ConflictException('Ya existe una empresa con ese NIT');
      }
      const out = await this.crearEmpresa(email, datos, pendiente.passwordHash);
      try {
        await this.pendientes
          .deleteOne({ _id: pendiente._id, tokenHash })
          .exec();
      } catch (err) {
        // La empresa ya existe: el enlace no puede crear otra (el correo ya
        // está en el directorio) y el pendiente vence solo.
        this.logger.error(
          `No se pudo borrar el pendiente de ${email}: ${String(err)}`,
        );
      }
      return out;
    } catch (err) {
      await this.pendientes
        .updateOne({ _id: pendiente._id }, { $unset: { consumiendoAt: 1 } })
        .exec()
        .catch((e: unknown) =>
          this.logger.error(
            `No se pudo soltar el pendiente de ${email}: ${String(e)}`,
          ),
        );
      throw err;
    }
  }

  /**
   * Un correo que no salió no puede quedar como éxito: el enlace no llegaría y
   * nadie lo sabría (4.11). Fuera de producción el correo simulado cuenta como
   * enviado. El mensaje es el mismo en los dos caminos y no lleva token.
   */
  private exigirEnviado(result: MailResult, email: string): void {
    if (result.sent || result.simulated) return;
    this.logger.error(`No salió el correo de registro a ${email}.`);
    throw new ServiceUnavailableException('Registro no disponible temporalmente');
  }

  private async crearEmpresa(
    email: string,
    dto: DatosRegistro,
    passwordHash: string,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView; plan: string }> {
    const business = await this.businesses.create({
      name: dto.businessName,
      nit: dto.nit,
      plan: dto.plan,
      tipoNegocio: dto.tipoNegocio,
      ownerEmail: email,
    });

    try {
      // A partir de aquí todo apunta a la base de la empresa recién creada.
      return await TenantContext.run(
        {
          businessId: business.id,
          dbName: business.dbName,
          tipoNegocio: business.tipoNegocio,
        },
        async () => {
          await this.roles.ensureSystemRoles();

          const sede = await this.sedes.create({
            code: 'principal',
            name: 'Sede principal',
            businessName: dto.businessName,
            nit: dto.nit,
            nitDv: dto.nitDv,
            tipoPersona: dto.tipoPersona,
            responsabilidadFiscal: dto.responsabilidadFiscal,
            ciiu: dto.ciiu,
            departamento: dto.departamento,
            ciudad: dto.ciudad,
            address: dto.address,
            phone: dto.phone,
            emailFacturacion: dto.emailFacturacion,
          });

          const user = await this.users.create(
            {
              email,
              password: '',
              name: dto.ownerName,
              role: ROLES.OWNER,
              sedeIds: [sede.id],
            },
            undefined,
            { passwordHash },
          );

          const session = await this.auth.issueSession(user);
          return { ...session, plan: business.plan };
        },
      );
    } catch (err) {
      // Compensación: sin esto el reintento chocaría con el NIT y el correo de
      // una empresa a medias que nadie puede abrir.
      await this.directory
        .unlink(email, business.id)
        .catch((e: unknown) =>
          this.logger.error(`No se pudo desvincular ${email}: ${String(e)}`),
        );
      await this.businesses
        .remove(business.id)
        .catch((e: unknown) =>
          this.logger.error(
            `No se pudo deshacer la empresa ${business.id}: ${String(e)}`,
          ),
        );
      throw err;
    }
  }

  private appUrl(): string {
    return (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
  }
}

/** Envíos ya hechos en la ventana de 24 h en curso (o una nueva si venció). */
function ventanaDeEnvios(
  p: Pick<RegistroPendiente, 'envios' | 'envioDiaInicio'> | null,
): { envios: number; inicio: Date } {
  const ahora = Date.now();
  if (p?.envioDiaInicio && p.envioDiaInicio.getTime() > ahora - DIA_MS) {
    return { envios: p.envios ?? 0, inicio: p.envioDiaInicio };
  }
  return { envios: 0, inicio: new Date(ahora) };
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
