import Busboy from '@fastify/busboy';
import type { FastifyRequest } from 'fastify';
import { fileBytes } from '../shared/files.ts';

type UploadedFile = { bytes: Buffer; filename: string; mimetype: string };

function formError(statusCode = 400) {
  return Object.assign(
    new Error(
      statusCode === 413
        ? 'The uploaded form is too large.'
        : 'The uploaded form could not be read.',
    ),
    { statusCode },
  );
}

export function createMultipartReader(options: {
  verifiedBody?: (request: FastifyRequest) => Buffer | undefined;
}) {
  const limits = { fileSize: fileBytes, files: 1, fields: 5 };
  return {
    limits,
    async readFile(request: FastifyRequest): Promise<UploadedFile | undefined> {
      if (!options.verifiedBody) {
        const file = await request.file();
        return file
          ? { bytes: await file.toBuffer(), filename: file.filename, mimetype: file.mimetype }
          : undefined;
      }
      const body = options.verifiedBody(request);
      if (!body)
        throw Object.assign(new Error('Runtime authentication failed.'), { statusCode: 401 });
      if (!request.isMultipart()) throw formError();
      let parser: InstanceType<typeof Busboy>;
      try {
        parser = new Busboy({
          headers: { 'content-type': request.headers['content-type']! },
          limits,
        });
      } catch {
        throw formError();
      }
      return new Promise<UploadedFile | undefined>((resolve, reject) => {
        let file: Omit<UploadedFile, 'bytes'> | undefined;
        const chunks: Buffer[] = [];
        let size = 0;
        let failure: ReturnType<typeof formError> | undefined;
        const fail = (statusCode = 400) => {
          failure ??= formError(statusCode);
          chunks.length = 0;
        };
        parser.on('file', (name, stream, filename, _encoding, mimetype) => {
          if (file) fail(413);
          if (name in Object.prototype) fail();
          file = { filename, mimetype };
          stream.on('limit', () => fail(413));
          stream.on('error', () => fail());
          stream.on('data', (chunk: Buffer) => {
            if (failure) return;
            size += chunk.length;
            if (size > limits.fileSize) fail(413);
            else chunks.push(chunk);
          });
        });
        parser.on('field', (name, value, nameTruncated, valueTruncated, _encoding, mimetype) => {
          if (name in Object.prototype || nameTruncated) fail();
          if (valueTruncated) fail(413);
          if (mimetype.startsWith('application/json')) {
            try {
              JSON.parse(value);
            } catch {
              fail();
            }
          }
        });
        for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const)
          parser.on(event, () => fail(413));
        parser.on('error', () => {
          fail();
          reject(failure);
        });
        parser.on('finish', () => {
          if (failure) reject(failure);
          else resolve(file ? { ...file, bytes: Buffer.concat(chunks, size) } : undefined);
        });
        parser.end(body);
      });
    },
  };
}
