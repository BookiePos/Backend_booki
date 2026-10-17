import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
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
import { MailService } from './mail.service';
import { RolesService } from './roles.service';
import { BCRYPT_ROUNDS, UsersService } from './users.service';

/** Horas de validez del enlace de confirmación. */
const CONFIRMACION_HORAS = 24;

/** Espera mínima entre dos correos de registro al mismo buzón. */
const ENFRIAMIENTO_MS = 60_000;

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
   * trabajo caro (un bcrypt y un correo).
   */
  async solicitar(dto: RegisterDto): Promise<void> {
    const email = dto.ownerEmail.toLowerCase().trim();
    // Se hashea siempre, también si el correo ya existe: así los dos caminos
    // tardan lo mismo y el tiempo de respuesta no delata la cuenta.
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Antiflood: un correo por buzón por minuto, pase lo que pase. Sin esto se
    // podía llenar un buzón ajeno desde muchas IPs.
    const reciente = await this.pendientes
      .findOne({ email, createdAt: { $gt: new Date(Date.now() - ENFRIAMIENTO_MS) } })
      .exec();
    if (reciente) return;

    if (await this.directory.exists(email)) {
      await this.pendientes.deleteMany({ email, tipo: 'aviso' }).exec();
      await this.pendientes.create({
        email,
        tipo: 'aviso',
        expiresAt: new Date(Date.now() + ENFRIAMIENTO_MS),
      });
      await this.mail.sendAvisoCuentaExistente({
        to: email,
        loginUrl: `${this.appUrl()}/login`,
        recoverUrl: `${this.appUrl()}/recuperar`,
      });
      return;
    }

    // Un solo enlace vivo por correo: pedir otro invalida el anterior.
    await this.pendientes.deleteMany({ email }).exec();
    const rawToken = randomBytes(32).toString('hex');
    const { password: _omitida, ...datos } = dto;
    void _omitida;
    await this.pendientes.create({
      email,
      tipo: 'confirmacion',
      tokenHash: hashToken(rawToken),
      datos: { ...datos, ownerEmail: email },
      passwordHash,
      expiresAt: new Date(Date.now() + CONFIRMACION_HORAS * 3_600_000),
    });
    const result = await this.mail.sendConfirmacionRegistro({
      to: email,
      confirmUrl: `${this.appUrl()}/registro/confirmar/${rawToken}`,
      businessName: dto.businessName,
      expiresHours: CONFIRMACION_HORAS,
    });
    if (!result.sent && !result.simulated) {
      // Quien se registra no puede saberlo (sería el mismo oráculo), así que
      // queda en el log para soporte.
      this.logger.error(`No salió el correo de confirmación de registro a ${email}.`);
    }
  }

  /**
   * Segundo paso: el dueño abrió el enlace. Consume el pendiente de forma
   * atómica (un enlace crea una sola empresa aunque se abra dos veces a la vez)
   * y crea la empresa con la sesión iniciada.
   */
  async confirmar(
    rawToken: string,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView; plan: string }> {
    const pendiente = await this.pendientes
      .findOneAndDelete({
        tokenHash: hashToken(rawToken),
        tipo: 'confirmacion',
        expiresAt: { $gt: new Date() },
      })
      .exec();
    if (!pendiente?.datos || !pendiente.passwordHash) {
      throw new NotFoundException(
        'El enlace de confirmación no es válido o ya venció. Vuelve a registrarte.',
      );
    }
    const datos = pendiente.datos as unknown as DatosRegistro;
    const email = pendiente.email;

    // Quien llega aquí ya probó que el buzón es suyo: a él sí se le puede decir
    // que el correo o el NIT se ocuparon mientras confirmaba.
    if (await this.directory.exists(email)) {
      throw new ConflictException(
        'Ya existe una cuenta con este correo. Inicia sesión o recupera tu contraseña.',
      );
    }
    if (datos.nit && (await this.businesses.nitExists(datos.nit))) {
      throw new ConflictException('Ya existe una empresa con ese NIT');
    }

    return this.crearEmpresa(email, datos, pendiente.passwordHash);
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

    // A partir de aquí todo apunta a la base de la empresa recién creada.
    return TenantContext.run(
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
  }

  private appUrl(): string {
    return (this.config.get<string>('APP_URL') ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
  }
}

function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
