import type { OpenAPIObject } from '@nestjs/swagger';
import { auditAnswer, openApiPath } from './response-audit.js';
import { checkSchema, type SchemaDocument } from './schema-check.js';

const doc: SchemaDocument = {
  components: {
    schemas: {
      Status: { type: 'string', enum: ['DRAFT', 'POSTED'] },
      Ref: {
        type: 'object',
        properties: { id: { type: 'string' }, nameEn: { type: 'string', nullable: true } },
        required: ['id', 'nameEn'],
      },
      Row: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          qty: { type: 'string', format: 'decimal' },
          count: { type: 'integer' },
          at: { type: 'string', format: 'date-time' },
          day: { type: 'string', format: 'date' },
          status: { allOf: [{ $ref: '#/components/schemas/Status' }] },
          party: { allOf: [{ $ref: '#/components/schemas/Ref' }], nullable: true },
          note: { type: 'string' },
          counts: { type: 'object', additionalProperties: { type: 'integer' } },
        },
        required: ['id', 'qty', 'count', 'at', 'status', 'party'],
      },
      Deleted: { type: 'object', properties: { deleted: { type: 'boolean', enum: [true] } }, required: ['deleted'] },
      Deactivated: { type: 'object', properties: { deactivated: { type: 'boolean', enum: [true] } }, required: ['deactivated'] },
    },
  },
};
const row = { $ref: '#/components/schemas/Row' };
const good = { id: '1', qty: '2.500', count: 3, at: '2026-01-01T00:00:00.000Z', status: 'DRAFT', party: null };

describe('checkSchema', () => {
  it('accepts a matching value, with an optional key absent and a nullable ref null', () => {
    expect(checkSchema(doc, row, good)).toEqual([]);
    expect(checkSchema(doc, row, { ...good, party: { id: '9', nameEn: null }, note: 'x', counts: { DRAFT: 2 } })).toEqual([]);
  });

  it('refuses a number where the schema says string (an amount sent as a JSON number)', () => {
    expect(checkSchema(doc, row, { ...good, qty: 2.5 })).toEqual(['$.qty: expected string, got number 2.5']);
  });

  it('refuses a string where the schema says integer, and a fraction for an integer', () => {
    expect(checkSchema(doc, row, { ...good, count: '3' })).toHaveLength(1);
    expect(checkSchema(doc, row, { ...good, count: 3.5 })).toHaveLength(1);
  });

  it('refuses a missing required key and an undeclared key', () => {
    const { at: _at, ...missing } = good;
    expect(checkSchema(doc, row, missing)).toEqual(['$.at: required, but missing']);
    expect(checkSchema(doc, row, { ...good, extra: 1 })).toEqual(['$.extra: not declared in the schema']);
  });

  it('refuses null where not nullable, a value outside the enum, and bad formats', () => {
    expect(checkSchema(doc, row, { ...good, id: null })).toEqual(['$.id: null, but not nullable']);
    expect(checkSchema(doc, row, { ...good, status: 'VOID' })).toHaveLength(1);
    expect(checkSchema(doc, row, { ...good, at: '2026-01-01' })).toHaveLength(1);
    expect(checkSchema(doc, row, { ...good, qty: '1,5' })).toHaveLength(1);
    expect(checkSchema(doc, row, { ...good, day: '2026-01-01' })).toEqual([]);
    expect(checkSchema(doc, row, { ...good, day: '2026-01-01T00:00:00.000Z' })).toHaveLength(1);
  });

  it('checks nested refs, additionalProperties and array items (each problem once)', () => {
    expect(checkSchema(doc, row, { ...good, party: { id: 1, nameEn: null } })).toEqual([
      '$.party.id: expected string, got integer 1',
    ]);
    expect(checkSchema(doc, row, { ...good, counts: { DRAFT: 'x' } })).toHaveLength(1);
    const list = { type: 'array', items: row };
    expect(checkSchema(doc, list, [good, { ...good, qty: 1 }, { ...good, qty: 2 }])).toEqual([
      '$[1].qty: expected string, got integer 1',
    ]);
  });

  it('accepts a value matching one variant of oneOf, and refuses one matching none', () => {
    const either = { oneOf: [{ $ref: '#/components/schemas/Deleted' }, { $ref: '#/components/schemas/Deactivated' }] };
    expect(checkSchema(doc, either, { deleted: true })).toEqual([]);
    expect(checkSchema(doc, either, { deactivated: true })).toEqual([]);
    expect(checkSchema(doc, either, { deleted: false })[0]).toMatch(/matches none of 2 variants/);
  });
});

describe('auditAnswer', () => {
  const api = {
    ...doc,
    paths: {
      '/api/v1/rows/{id}': {
        get: { responses: { 200: { description: '', content: { 'application/json': { schema: row } } } } },
        delete: { responses: { 204: { description: '' } } },
      },
      '/api/v1/rows/{id}/pdf': {
        get: { responses: { 200: { description: '', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } } } },
      },
    },
  } as unknown as OpenAPIObject;

  it('maps an Express route to its OpenAPI path', () => {
    expect(openApiPath('/api/v1/rows/:id/lines/:lineId')).toBe('/api/v1/rows/{id}/lines/{lineId}');
  });

  it('checks the JSON body of a declared status, and ignores errors', () => {
    expect(auditAnswer(api, 'GET', '/api/v1/rows/{id}', 200, 'application/json', { json: true, value: good })).toEqual([]);
    expect(auditAnswer(api, 'GET', '/api/v1/rows/{id}', 200, 'application/json', { json: true, value: { ...good, qty: 1 } })).toHaveLength(1);
    expect(auditAnswer(api, 'GET', '/api/v1/rows/{id}', 404, 'application/json', { json: true, value: {} })).toEqual([]);
  });

  it('reports an undeclared status, a missing JSON body, and an unexpected one', () => {
    expect(auditAnswer(api, 'GET', '/api/v1/rows/{id}', 201, undefined, { json: true, value: good })[0]).toMatch(/status 201 is not declared/);
    expect(auditAnswer(api, 'GET', '/api/v1/rows/{id}', 200, undefined, { json: false })).toEqual(['declared a JSON body, but none was sent']);
    expect(auditAnswer(api, 'DELETE', '/api/v1/rows/{id}', 204, undefined, { json: false })).toEqual([]);
    expect(auditAnswer(api, 'GET', '/api/v1/rows/{id}/pdf', 200, 'application/pdf', { json: false })).toEqual([]);
    expect(auditAnswer(api, 'GET', '/api/v1/rows/{id}/pdf', 200, 'application/json', { json: true, value: {} })).toEqual([
      'sent a JSON body, but the response declares none',
    ]);
  });
});
