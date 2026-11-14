import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, getSchemaPath, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ErrorBodyDto, ErrorResponseDto } from './responses.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'] as const;

/**
 * The API's OpenAPI document (PLAT-15). Every operation documents its success
 * response on the route; this adds the error envelope as the `default`
 * response of every operation, since every error goes through the global
 * exception filter.
 */
export function buildApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('ERP Cloud API')
    .setDescription('Accounting & inventory SaaS API')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config, { extraModels: [ErrorResponseDto, ErrorBodyDto] });
  const error = {
    description: 'Error envelope (common/filters/all-exceptions.filter.ts)',
    content: { 'application/json': { schema: { $ref: getSchemaPath(ErrorResponseDto) } } },
  };
  for (const item of Object.values(document.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (operation) operation.responses = { ...operation.responses, default: error };
    }
  }
  return document;
}
