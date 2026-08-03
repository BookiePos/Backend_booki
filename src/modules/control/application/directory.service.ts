import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CONTROL_CONNECTION } from '../domain/control.constants';
import {
  BusinessDirectory,
  BusinessDirectoryDocument,
} from '../infrastructure/schemas/business-directory.schema';

/**
 * Directorio global email → empresa (base de control). Enruta el login y
 * garantiza unicidad global de correos. Se actualiza cada vez que se crea un
 * usuario en cualquier empresa.
 */
@Injectable()
export class DirectoryService {
  constructor(
    @InjectModel(BusinessDirectory.name, CONTROL_CONNECTION)
    private readonly directory: Model<BusinessDirectoryDocument>,
  ) {}

  /** Empresa a la que pertenece un correo, o null si no está registrado. */
  findByEmail(email: string): Promise<BusinessDirectoryDocument | null> {
    return this.directory.findOne({ email: email.toLowerCase() }).exec();
  }

  /** ¿El correo ya está usado por alguna empresa? */
  async exists(email: string): Promise<boolean> {
    return (await this.directory.exists({ email: email.toLowerCase() })) != null;
  }

  /** Registra (o reafirma) el vínculo email → empresa. Idempotente. */
  async link(email: string, businessId: string, dbName: string): Promise<void> {
    await this.directory
      .updateOne(
        { email: email.toLowerCase() },
        { $set: { businessId, dbName } },
        { upsert: true },
      )
      .exec();
  }
}
