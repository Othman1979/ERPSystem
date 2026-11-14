/**
 * Checks a JSON value against an OpenAPI 3.0 schema of this API's document
 * (PLAT-15): the e2e contract spec and the response audit use it to prove that
 * a declared response type is what the endpoint really sends.
 *
 * Stricter than JSON Schema on purpose: an object key the schema does not
 * declare is an error (unless `additionalProperties` allows it), so a DTO that
 * forgets a field fails as surely as one that invents a field. It knows the
 * keywords this API's document uses: $ref, allOf, oneOf, anyOf, type,
 * nullable, enum, properties, required, additionalProperties, items, and the
 * formats date, date-time and decimal.
 */

export interface SchemaObject {
  $ref?: string;
  type?: string;
  format?: string;
  nullable?: boolean;
  enum?: unknown[];
  properties?: Record<string, SchemaObject>;
  required?: string[];
  additionalProperties?: boolean | SchemaObject;
  items?: SchemaObject;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
}

export interface SchemaDocument {
  components?: { schemas?: Record<string, SchemaObject> };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
/** Decimal.toString(): plain digits, or exponent notation for very small or large values. */
const DECIMAL = /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i;

function resolve(doc: SchemaDocument, schema: SchemaObject): SchemaObject {
  let current = schema;
  for (let depth = 0; current.$ref; depth++) {
    if (depth > 32) throw new Error(`$ref loop at ${schema.$ref}`);
    const name = current.$ref.replace('#/components/schemas/', '');
    const target = doc.components?.schemas?.[name];
    if (!target) throw new Error(`Unknown schema ${current.$ref}`);
    current = target;
  }
  return current;
}

/** The schema with its $ref resolved and its allOf parts merged into one. */
function flatten(doc: SchemaDocument, schema: SchemaObject): SchemaObject {
  const base = resolve(doc, schema);
  if (!base.allOf) return base;
  const merged: SchemaObject = { ...base, allOf: undefined };
  for (const part of base.allOf.map((p) => flatten(doc, p))) {
    for (const [key, value] of Object.entries(part)) {
      if (key === 'properties') merged.properties = { ...merged.properties, ...part.properties };
      else if (key === 'required') merged.required = [...(merged.required ?? []), ...(part.required ?? [])];
      else if (key === 'nullable') merged.nullable = merged.nullable || part.nullable;
      else if (!(key in merged) || (merged as Record<string, unknown>)[key] === undefined) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
  }
  return merged;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/**
 * The places where `value` does not match `schema`, as `path: problem`
 * strings; empty when it matches. Only the first few array items are
 * reported per problem, so a long list stays readable.
 */
export function checkSchema(doc: SchemaDocument, schema: SchemaObject, value: unknown, path = '$'): string[] {
  const s = flatten(doc, schema);
  if (value === null) return s.nullable ? [] : [`${path}: null, but not nullable`];

  const branches = s.oneOf ?? s.anyOf;
  if (branches) {
    const results = branches.map((b) => checkSchema(doc, b, value, path));
    if (results.some((r) => r.length === 0)) return [];
    const best = results.reduce((a, b) => (b.length < a.length ? b : a));
    return [`${path}: matches none of ${branches.length} variants; closest:`, ...best];
  }

  if (s.enum && !s.enum.includes(value)) return [`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(s.enum)}`];

  const actual = typeOf(value);
  if (s.type) {
    const ok = s.type === actual || (s.type === 'number' && actual === 'integer');
    if (!ok) return [`${path}: expected ${s.type}, got ${actual} ${JSON.stringify(value)?.slice(0, 60)}`];
  }

  if (typeof value === 'string') {
    if (s.format === 'date' && !DATE.test(value)) return [`${path}: "${value}" is not a date (YYYY-MM-DD)`];
    if (s.format === 'date-time' && !DATE_TIME.test(value)) return [`${path}: "${value}" is not a date-time`];
    if (s.format === 'decimal' && !DECIMAL.test(value)) return [`${path}: "${value}" is not a decimal string`];
    return [];
  }

  if (Array.isArray(value)) {
    if (!s.items) return s.type === 'array' ? [] : [`${path}: array where the schema has no items`];
    const errors: string[] = [];
    const seen = new Set<string>();
    value.forEach((item, i) => {
      for (const e of checkSchema(doc, s.items!, item, `${path}[${i}]`)) {
        // One report per place and kind of problem, whatever the item and value.
        const key = e.replace(/\[\d+\]/g, '[]').replace(/ got (\w+) .*$/, ' got $1');
        if (!seen.has(key)) {
          seen.add(key);
          errors.push(e);
        }
      }
    });
    return errors;
  }

  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    const errors: string[] = [];
    const props = s.properties ?? {};
    const declaresShape = s.properties !== undefined || s.additionalProperties !== undefined;
    if (!declaresShape) {
      return s.type === 'object' || s.type === undefined ? [] : [`${path}: object where the schema has no shape`];
    }
    for (const key of s.required ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required, but missing`);
    }
    for (const [key, item] of Object.entries(obj)) {
      if (props[key]) errors.push(...checkSchema(doc, props[key], item, `${path}.${key}`));
      else if (s.additionalProperties === true) continue;
      else if (s.additionalProperties) errors.push(...checkSchema(doc, s.additionalProperties, item, `${path}.${key}`));
      else errors.push(`${path}.${key}: not declared in the schema`);
    }
    return errors;
  }
  return [];
}
