/**
 * Response audit (PLAT-15), for tests only: with OPENAPI_RESPONSE_AUDIT set to
 * a file path (and NODE_ENV not production), every 2xx answer is checked
 * against the response its operation declares in the OpenAPI document, and
 * each mismatch is appended to that file as one JSON line. CI runs the whole
 * e2e corpus this way and fails on a non-empty file, so a declared type that
 * is wrong fails a test wherever an e2e suite calls the route.
 *
 * It only observes: the body is passed on unchanged, and a failure to check
 * or to write is swallowed.
 */
import { appendFileSync } from 'node:fs';
import type { NextFunction, Request, Response } from 'express';
import type { OpenAPIObject } from '@nestjs/swagger';
import { checkSchema, type SchemaDocument, type SchemaObject } from './schema-check.js';

interface ResponseObject {
  content?: Record<string, { schema?: SchemaObject }>;
}

export interface AuditFinding {
  method: string;
  route: string;
  status: number;
  problems: string[];
}

/** `/api/v1/parties/:id` (Express) as `/api/v1/parties/{id}` (OpenAPI). */
export function openApiPath(expressPath: string): string {
  return expressPath.replace(/:(\w+)/g, '{$1}');
}

/** The problems of one answer against its operation; empty when it matches or is not checked. */
export function auditAnswer(
  doc: OpenAPIObject,
  method: string,
  route: string,
  status: number,
  contentType: string | undefined,
  body: { json: true; value: unknown } | { json: false },
): string[] {
  if (status < 200 || status >= 300) return [];
  const operation = (doc.paths[route] as Record<string, { responses?: Record<string, ResponseObject> }> | undefined)?.[
    method.toLowerCase()
  ];
  if (!operation) return [`no operation ${method} ${route} in the document`];
  const declared = operation.responses?.[String(status)];
  if (!declared) {
    const codes = Object.keys(operation.responses ?? {}).filter((c) => c !== 'default');
    return [`status ${status} is not declared (declared: ${codes.join(', ') || 'none'})`];
  }
  const jsonSchema = declared.content?.['application/json']?.schema;
  if (!body.json) {
    if (jsonSchema && (!contentType || contentType.includes('json'))) return ['declared a JSON body, but none was sent'];
    return [];
  }
  if (!jsonSchema) return ['sent a JSON body, but the response declares none'];
  return checkSchema(doc as unknown as SchemaDocument, jsonSchema, body.value);
}

/** Express middleware that records every 2xx answer that does not match its declared schema. */
export function responseAudit(doc: OpenAPIObject, file: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    let jsonBody: { value: unknown } | null = null;
    const json = res.json.bind(res);
    res.json = (value: unknown) => {
      jsonBody = { value };
      return json(value);
    };
    res.on('finish', () => {
      try {
        const routePath = (req.route as { path?: unknown } | undefined)?.path;
        if (typeof routePath !== 'string') return;
        const route = openApiPath(routePath);
        // The API's own routes only: not the Swagger UI or its JSON (/api/docs).
        if (!route.startsWith('/api/v1/')) return;
        // As the client sees it: Dates become strings, undefined keys disappear.
        const body = jsonBody
          ? { json: true as const, value: JSON.parse(JSON.stringify(jsonBody.value) ?? 'null') as unknown }
          : { json: false as const };
        const contentType = res.getHeader('content-type');
        const problems = auditAnswer(
          doc,
          req.method,
          route,
          res.statusCode,
          typeof contentType === 'string' ? contentType : undefined,
          body,
        );
        if (problems.length === 0) return;
        const finding: AuditFinding = { method: req.method, route, status: res.statusCode, problems: problems.slice(0, 20) };
        appendFileSync(file, `${JSON.stringify(finding)}\n`);
      } catch {
        // An audit failure never affects the answer.
      }
    });
    next();
  };
}
