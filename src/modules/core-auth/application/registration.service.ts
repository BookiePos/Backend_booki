import { ConflictException, Injectable } from '@nestjs/common';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { BusinessService } from '../../control/application/business.service';
import { DirectoryService } from '../../control/application/directory.service';
import { SedesService } from '../../sedes/application/sedes.service';
import { ROLES } from '../domain/roles';
import { RegisterDto } from './dto/register.dto';
import { AuthService, AuthTokens, AuthUserView } from './auth.service';
import { RolesService } from './roles.service';
import { UsersService } from './users.service';

/**
 * Alta de una empresa nueva (tenant) desde la web pública.
 *
 * Crea el registro de la empresa en el control-plane y luego provisiona SU base
 * de datos (roles de sistema, primera sede con los datos fiscales, usuario
 * Dueño) dentro del contexto de esa empresa, reusando los servicios existentes.
 * El Dueño trae todos los permisos, así que "Operación" ya incluye el POS.
 */
@Injectable()
export class RegistrationService {
  constructor(
    private readonly businesses: BusinessService,
    private readonly directory: DirectoryService,
    private readonly roles: RolesService,
    private readonly sedes: SedesService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  async register(
    dto: RegisterDto,
  ): Promise<{ tokens: AuthTokens; user: AuthUserView; plan: string }> {
    const email = dto.ownerEmail.toLowerCase();

    if (await this.directory.exists(email)) {
      throw new ConflictException('El correo ya está registrado');
    }
    if (dto.nit && (await this.businesses.nitExists(dto.nit))) {
      throw new ConflictException('Ya existe una empresa con ese NIT');
    }

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

        const user = await this.users.create({
          email,
          password: dto.password,
          name: dto.ownerName,
          role: ROLES.OWNER,
          sedeIds: [sede.id],
        });

        const session = await this.auth.issueSession(user);
        return { ...session, plan: business.plan };
      },
    );
  }
}
