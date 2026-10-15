import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import {
  detectFileType,
  validateUploadedFile,
  IMAGE_MIMES,
} from './file-signature';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x10, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const AVIF = Buffer.concat([
  Buffer.from([0, 0, 0, 0x1c]),
  Buffer.from('ftypavif'),
  Buffer.from([0, 0, 0, 0]),
]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

describe('detectFileType', () => {
  it('reconoce JPEG, PNG, WebP, AVIF y PDF por sus bytes', () => {
    expect(detectFileType(JPEG)).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(detectFileType(PNG)).toEqual({ mime: 'image/png', ext: 'png' });
    expect(detectFileType(WEBP)).toEqual({ mime: 'image/webp', ext: 'webp' });
    expect(detectFileType(AVIF)).toEqual({ mime: 'image/avif', ext: 'avif' });
    expect(detectFileType(PDF)).toEqual({ mime: 'application/pdf', ext: 'pdf' });
  });

  it('no reconoce HTML, SVG, vacío ni basura', () => {
    expect(detectFileType(HTML)).toBeNull();
    expect(detectFileType(SVG)).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
    expect(detectFileType(Buffer.from('RIFF....WAVE'))).toBeNull();
  });
});

describe('validateUploadedFile', () => {
  it('una JPEG real pasa y el tipo sale del contenido', () => {
    expect(validateUploadedFile(JPEG, IMAGE_MIMES, 'JPG')).toEqual({
      mime: 'image/jpeg',
      ext: 'jpg',
    });
  });

  it('un PDF real pasa solo si el endpoint lo permite', () => {
    expect(validateUploadedFile(PDF, ['application/pdf'], 'PDF').ext).toBe('pdf');
    expect(() => validateUploadedFile(PDF, IMAGE_MIMES, 'imagen')).toThrow(
      BadRequestException,
    );
  });

  it('un PNG renombrado a .pdf se rechaza donde solo se admite PDF', () => {
    expect(() => validateUploadedFile(PNG, ['application/pdf'], 'PDF')).toThrow(
      BadRequestException,
    );
  });

  it('un HTML con mimetype image/png se rechaza', () => {
    expect(() => validateUploadedFile(HTML, IMAGE_MIMES, 'imagen')).toThrow(
      BadRequestException,
    );
  });

  it('un SVG se rechaza', () => {
    expect(() => validateUploadedFile(SVG, IMAGE_MIMES, 'imagen')).toThrow(
      BadRequestException,
    );
  });
});
