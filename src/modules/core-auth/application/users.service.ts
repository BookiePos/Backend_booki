import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { User, UserDocument } from '../infrastructure/schemas/user.schema';
import {
  RefreshToken,
  RefreshTokenDocument,
} from '../infrastructure/schemas/refresh-token.schema';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { RolesService } from './roles.service';
import { TenantContext } from '../../../shared/tenancy/tenant-context';
import { DirectoryService } from '../../control/application/directory.service';
import { SedesService } from '../../sedes/application/sedes.service';
import { effectiveEntitlements } from '../../control/domain/plans';
import { PlanUpgradeRequiredException } from '../../control/domain/plan-upgrade.exception';
import { ALL_PERMISSIONS } from '../domain/permissions';
import { ROLES } from '../domain/roles';
import { canViewAllSedes } from '../domain/sede-access';

const BCRYPT_ROUNDS = 10;
const DUENO_UNICO_MSG =
  'La empresa debe conservar al menos un Dueño activo: nombra otro Dueño antes.';

/**
 * Quien da de alta, edita o invita a un usuario. Es el `JwtUser` de la request;
 * se declara aparte para que el servicio no dependa de la capa de
 * infraestructura. Los flujos internos (registro de la empresa, aceptar una
 * invitación ya validada) no lo pasan.
 */
export interface GestorDeUsuarios {
  userId: string;
  role: string;
  permissions: string[];
  /** Sedes a las que está limitado (no cuentan si ve todas). */
  sedeIds: string[];
  /** Sesión (jti del refresh token) desde la que actúa, si el token la trae. */
  sid?: string;
}

/** ¿Las dos listas tienen los mismos elementos, sin importar el orden? */
function mismoConjunto(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly roles: RolesService,
    private readonly directory: DirectoryService,
    private readonly sedes: SedesService,
    @InjectModel(RefreshToken.name)
    private readonly refreshModel: Model<RefreshTokenDocument>,
  ) {}

  async create(
    dto: CreateUserDto,
    actor?: GestorDeUsuarios,
  ): Promise<UserDocument> {
    const ctx = TenantContext.currentOrThrow();
    const { businessId, dbName } = ctx;
    if (ctx.plan) {
      const { quotas } = effectiveEntitlements(ctx.plan, ctx.addOns);
      if (quotas.users !== null) {
        const current = await this.count();
        if (current >= quotas.users) {
          throw new PlanUpgradeRequiredException(
            `Tu plan permite ${quotas.users} usuarios. Mejora tu plan para agregar más.`,
            { reason: 'quota', quota: 'users' },
          );
        }
      }
    }
    const username = dto.username?.toLowerCase().trim() || undefined;

    if (!dto.email && !username) {
      throw new BadRequestException('Indica un email o un nombre de usuario');
    }

    // Con username y sin email, se sintetiza un email interno único por empresa
    // (`<username>@<businessId>.local`) para reusar el enrutamiento por email.
    const email = (
      dto.email ?? `${username}@${businessId}.local`
    ).toLowerCase();

    // Unicidad global de correos: no puede existir en ninguna otra empresa.
    if (await this.directory.exists(email)) {
      throw new ConflictException('El email ya está registrado');
    }
    // Unicidad global de username (enrutamiento de login por username).
    if (username && (await this.directory.usernameExists(username))) {
      throw new ConflictException('El nombre de usuario ya está en uso');
    }
    const role = await this.roles.findByKey(dto.role);
    if (!role) {
      throw new BadRequestException('Rol no válido');
    }
    this.assertPermisosDelCatalogo(dto.extraPermissions ?? []);
    await this.assertSedesExisten(dto.sedeIds ?? []);
    if (actor) {
      await this.assertPuedeAsignarRol(actor, role.key);
      this.assertPuedeConceder(actor, dto.extraPermissions ?? []);
      this.assertPuedeRepartirSedes(actor, dto.sedeIds ?? []);
    }
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const created = await this.userModel.create({
      email,
      username,
      passwordHash,
      name: dto.name,
      role: role.key,
      extraPermissions: dto.extraPermissions ?? [],
      sedeIds: (dto.sedeIds ?? []).map((id) => new Types.ObjectId(id)),
    });
    // Registra el vínculo email/username → empresa para enrutar el login.
    await this.directory.link(email, businessId, dbName, username);
    return created;
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor?: GestorDeUsuarios,
  ): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    if (dto.extraPermissions !== undefined) {
      // Solo lo que se AÑADE: un usuario antiguo con un permiso ya retirado del
      // catálogo no debe quedar ineditable; ese texto no concede nada.
      this.assertPermisosDelCatalogo(
        dto.extraPermissions.filter((p) => !user.extraPermissions.includes(p)),
      );
    }
    // Como con los permisos extra, solo cuenta lo que se AÑADE: quitar sedes o
    // conservar las que ya tenía no reparte acceso nuevo.
    const sedesActuales = user.sedeIds.map((s) => s.toString());
    const sedesNuevas =
      dto.sedeIds === undefined
        ? []
        : dto.sedeIds.filter((s) => !sedesActuales.includes(s));
    await this.assertSedesExisten(sedesNuevas);
    if (actor) {
      await this.assertPuedeEditar(actor, user, dto, sedesNuevas);
    }
    const quitaDueno = this.quitaUnDuenoActivo(user, dto);
    if (quitaDueno) await this.assertQuedaOtroDueno();
    const antes = { role: user.role, active: user.active };
    // Se calcula ANTES de tocar el documento: compara contra lo guardado.
    const cierraSesiones = this.cambiaLoQueViajaEnElToken(user, dto);
    if (dto.name !== undefined) {
      user.name = dto.name;
    }
    if (dto.role !== undefined) {
      const role = await this.roles.findByKey(dto.role);
      if (!role) {
        throw new BadRequestException('Rol no válido');
      }
      user.role = role.key;
    }
    if (dto.active !== undefined) {
      user.active = dto.active;
    }
    if (dto.extraPermissions !== undefined) {
      user.extraPermissions = dto.extraPermissions;
    }
    if (dto.sedeIds !== undefined) {
      user.sedeIds = dto.sedeIds.map((sid) => new Types.ObjectId(sid));
    }
    if (dto.password !== undefined) {
      user.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    }
    await user.save();
    if (quitaDueno) {
      // Dos Dueños que se degradan o desactivan a la vez pasan ambos el conteo
      // de arriba: se vuelve a contar ya guardado y, si no quedó ninguno, se
      // deshace este cambio.
      const quedan = await this.userModel
        .countDocuments({ role: ROLES.OWNER, active: true })
        .exec();
      if (quedan < 1) {
        user.role = antes.role;
        user.active = antes.active;
        await user.save();
        throw new BadRequestException(DUENO_UNICO_MSG);
      }
    }
    if (cierraSesiones) {
      // Quien se cambia a sí mismo la contraseña conserva la sesión desde la
      // que lo hace; las demás se cierran. Desactivarse lo cierra todo.
      const conservar =
        actor?.userId === user.id && dto.active !== false ? actor.sid : undefined;
      await this.revokeAllSessions(user.id, conservar);
    }
    return user;
  }

  /**
   * Ítem 3.2: rol, permisos extra y sedes viajan dentro del access token, y el
   * refresh lo vuelve a emitir con los datos de la base. Si alguno cambia —o se
   * desactiva la cuenta o se cambia la contraseña— se revocan sus refresh
   * tokens para que la sesión vieja no siga renovándose con lo de antes.
   *
   * Solo cuenta lo que CAMBIA: la pantalla de usuarios reenvía el formulario
   * entero, y cambiarse el nombre no debe echarle a uno de su propia sesión.
   */
  private cambiaLoQueViajaEnElToken(
    user: UserDocument,
    dto: UpdateUserDto,
  ): boolean {
    return (
      dto.password !== undefined ||
      (dto.active !== undefined && dto.active !== user.active) ||
      (dto.role !== undefined && dto.role.toLowerCase() !== user.role) ||
      (dto.extraPermissions !== undefined &&
        !mismoConjunto(dto.extraPermissions, user.extraPermissions)) ||
      (dto.sedeIds !== undefined &&
        !mismoConjunto(
          dto.sedeIds,
          user.sedeIds.map((s) => s.toString()),
        ))
    );
  }

  /**
   * Revoca todas las sesiones abiertas de un usuario: sus refresh tokens dejan
   * de servir y, como mucho, le queda el access token vigente (minutos). Vive
   * aquí y no en `AuthService` porque `AuthService` ya depende de este
   * servicio (al revés sería una dependencia circular); `AuthService` delega en
   * este. Debe llamarse dentro del `TenantContext` de la empresa del usuario.
   */
  async revokeAllSessions(userId: string, exceptJti?: string): Promise<void> {
    await this.refreshModel
      .updateMany(
        {
          userId: new Types.ObjectId(userId),
          revoked: false,
          ...(exceptJti ? { jti: { $ne: exceptJti } } : {}),
        },
        { $set: { revoked: true } },
      )
      .exec();
  }

  /**
   * La empresa nunca se queda sin un Dueño activo: sin él nadie podría volver a
   * nombrar Dueños ni tocar el rol Dueño. Degradar o desactivar al último es un
   * 400, lo pida quien lo pida (también el propio Dueño).
   */
  private quitaUnDuenoActivo(user: UserDocument, dto: UpdateUserDto): boolean {
    if (user.role !== ROLES.OWNER || !user.active) return false;
    const loDesactiva = dto.active === false;
    const loDegrada =
      dto.role !== undefined && dto.role.toLowerCase() !== ROLES.OWNER;
    return loDesactiva || loDegrada;
  }

  private async assertQuedaOtroDueno(): Promise<void> {
    const duenosActivos = await this.userModel
      .countDocuments({ role: ROLES.OWNER, active: true })
      .exec();
    if (duenosActivos <= 1) {
      throw new BadRequestException(DUENO_UNICO_MSG);
    }
  }

  /**
   * Las reglas que impiden tomarse la cuenta del Dueño (ítem 3.1).
   *
   * `users.manage` bastaba para todo: un Administrador podía ponerse rol de
   * Dueño, regalarse `sede.view_all`, cambiarle la contraseña al Dueño o
   * desactivarlo. Se cierra con estas reglas, y solo se evalúa lo que CAMBIA,
   * porque la pantalla de usuarios reenvía el formulario entero en cada PATCH:
   *  - al Dueño solo lo toca otro Dueño, y solo un Dueño nombra Dueños;
   *  - nadie se cambia su propio rol ni sus permisos extra, ni se amplía sedes;
   *  - nadie concede un permiso ni reparte una sede que él mismo no tiene;
   *  - cualquier cambio de contraseña, rol, permisos extra, sedes o
   *    desactivación de OTRO, solo si ese otro no tiene permisos que el actor
   *    no tenga (si no, sería tomarse su cuenta o bajarlo de rango).
   */
  private async assertPuedeEditar(
    actor: GestorDeUsuarios,
    user: UserDocument,
    dto: UpdateUserDto,
    sedesNuevas: string[],
  ): Promise<void> {
    if (user.role === ROLES.OWNER && actor.role !== ROLES.OWNER) {
      throw new ForbiddenException('Solo el Dueño puede editar al Dueño');
    }
    const cambiaRol =
      dto.role !== undefined && dto.role.toLowerCase() !== user.role;
    const extrasNuevos =
      dto.extraPermissions === undefined
        ? []
        : dto.extraPermissions.filter(
            (p) => !user.extraPermissions.includes(p),
          );
    const cambianExtras =
      dto.extraPermissions !== undefined &&
      (extrasNuevos.length > 0 ||
        dto.extraPermissions.length !== user.extraPermissions.length);
    if (user.id === actor.userId && (cambiaRol || cambianExtras)) {
      throw new ForbiddenException(
        'No puedes cambiar tu propio rol ni tus permisos: pídeselo a otra persona que gestione usuarios.',
      );
    }
    if (
      user.id === actor.userId &&
      sedesNuevas.length > 0 &&
      !canViewAllSedes(actor)
    ) {
      throw new ForbiddenException(
        'No puedes ampliar tus propias sedes: pídeselo a otra persona que gestione usuarios.',
      );
    }
    if (cambiaRol) {
      await this.assertPuedeAsignarRol(actor, dto.role as string);
    }
    this.assertPuedeConceder(actor, extrasNuevos);
    this.assertPuedeRepartirSedes(actor, sedesNuevas);
    const cambiaSedes =
      dto.sedeIds !== undefined &&
      !mismoConjunto(
        dto.sedeIds,
        user.sedeIds.map((s) => s.toString()),
      );
    const tomaLaCuenta =
      dto.password !== undefined ||
      (dto.active === false && user.active) ||
      cambiaRol ||
      cambianExtras ||
      cambiaSedes;
    if (user.id !== actor.userId && tomaLaCuenta) {
      const propios = new Set(actor.permissions);
      const ajenos = (await this.effectivePermissions(user)).filter(
        (p) => !propios.has(p),
      );
      if (ajenos.length > 0) {
        throw new ForbiddenException(
          'No puedes cambiar la contraseña, el rol, los permisos ni las sedes, ni desactivar, a alguien con permisos que tú no tienes.',
        );
      }
    }
  }

  /** Quien no ve todas las sedes solo reparte las suyas. */
  private assertPuedeRepartirSedes(
    actor: GestorDeUsuarios,
    sedeIds: string[],
  ): void {
    if (canViewAllSedes(actor)) return;
    const propias = new Set(actor.sedeIds);
    if (sedeIds.some((s) => !propias.has(s))) {
      throw new ForbiddenException(
        'No puedes asignar sedes a las que no tienes acceso',
      );
    }
  }

  /** Las sedes asignadas deben existir en la empresa activa. */
  private async assertSedesExisten(sedeIds: string[]): Promise<void> {
    const unicas = [...new Set(sedeIds)];
    if (unicas.length === 0) return;
    const encontradas = await this.sedes.list(unicas);
    if (encontradas.length !== unicas.length) {
      throw new BadRequestException('Sede no válida');
    }
  }

  /**
   * Un rol se puede asignar (al crear, editar o invitar) si no es el de Dueño
   * —eso queda para otro Dueño— y no trae permisos que el actor no tiene.
   */
  async assertPuedeAsignarRol(
    actor: GestorDeUsuarios,
    roleKey: string,
  ): Promise<void> {
    const key = roleKey.toLowerCase();
    if (key === ROLES.OWNER && actor.role !== ROLES.OWNER) {
      throw new ForbiddenException('Solo el Dueño puede asignar el rol de Dueño');
    }
    this.assertPuedeConceder(actor, await this.roles.permissionsForRole(key));
  }

  private assertPuedeConceder(
    actor: GestorDeUsuarios,
    permissions: string[],
  ): void {
    const propios = new Set(actor.permissions);
    const ajenos = permissions.filter((p) => !propios.has(p));
    if (ajenos.length > 0) {
      throw new ForbiddenException(
        `No puedes conceder permisos que no tienes: ${ajenos.join(', ')}`,
      );
    }
  }

  /** Mismo criterio que `RolesService`: solo permisos del catálogo. */
  private assertPermisosDelCatalogo(permissions: string[]): void {
    const allowed = new Set<string>(ALL_PERMISSIONS);
    const invalid = permissions.filter((p) => !allowed.has(p));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Permisos no válidos: ${invalid.join(', ')}`,
      );
    }
  }

  findByEmail(email: string): Promise<UserDocument | null> {
    return this.userModel.findOne({ email: email.toLowerCase() }).exec();
  }

  findByUsername(username: string): Promise<UserDocument | null> {
    return this.userModel
      .findOne({ username: username.toLowerCase() })
      .exec();
  }

  async findById(id: string): Promise<UserDocument> {
    const user = await this.userModel.findById(id).exec();
    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }
    return user;
  }

  list(): Promise<UserDocument[]> {
    return this.userModel.find().select('-passwordHash').exec();
  }

  count(): Promise<number> {
    return this.userModel.countDocuments().exec();
  }

  verifyPassword(user: UserDocument, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }

  /** Cambia la contraseña de un usuario ya resuelto (recuperación por correo). */
  async setPassword(user: UserDocument, password: string): Promise<void> {
    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await user.save();
  }

  /** Permisos efectivos = permisos del rol (DB) + permisos extra del usuario. */
  async effectivePermissions(user: UserDocument): Promise<string[]> {
    const rolePerms = await this.roles.permissionsForRole(user.role);
    const set = new Set<string>([...rolePerms, ...user.extraPermissions]);
    return [...set];
  }
}
