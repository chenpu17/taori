import { z } from 'zod';

type JsonSchema = {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  items?: unknown;
  enum?: unknown;
  additionalProperties?: unknown;
  minLength?: unknown;
  maxLength?: unknown;
  minimum?: unknown;
  maximum?: unknown;
};

export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  if (!schema || typeof schema !== 'object') {
    return z.record(z.unknown());
  }
  return convert(schema as JsonSchema);
}

function convert(schema: JsonSchema): z.ZodTypeAny {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals = schema.enum.map((value) => z.literal(value as never));
    return literals.length === 1
      ? literals[0]!
      : z.union(literals as [z.ZodLiteral<never>, z.ZodLiteral<never>, ...z.ZodLiteral<never>[]]);
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes('null');
  const concrete = types.find((item) => item !== 'null');
  let zod: z.ZodTypeAny;

  switch (concrete) {
    case 'object':
    case undefined:
      zod = convertObject(schema);
      break;
    case 'array':
      zod = z.array(convert(asObject(schema.items) ?? {}));
      break;
    case 'string':
      zod = convertString(schema);
      break;
    case 'integer':
      zod = convertNumber(schema).int();
      break;
    case 'number':
      zod = convertNumber(schema);
      break;
    case 'boolean':
      zod = z.boolean();
      break;
    default:
      zod = z.unknown();
      break;
  }

  return nullable ? zod.nullable() : zod;
}

function convertObject(schema: JsonSchema): z.ZodTypeAny {
  const properties = asRecord(schema.properties);
  if (!properties) {
    return schema.additionalProperties === false
      ? z.object({}).strict()
      : z.record(z.unknown());
  }

  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === 'string') : []);
  const shape: z.ZodRawShape = {};
  for (const [key, value] of Object.entries(properties)) {
    const field = convert(asObject(value) ?? {});
    shape[key] = required.has(key) ? field : field.optional();
  }

  const object = z.object(shape);
  return schema.additionalProperties === false ? object.strict() : object.passthrough();
}

function convertString(schema: JsonSchema): z.ZodString {
  let out = z.string();
  if (typeof schema.minLength === 'number') out = out.min(schema.minLength);
  if (typeof schema.maxLength === 'number') out = out.max(schema.maxLength);
  return out;
}

function convertNumber(schema: JsonSchema): z.ZodNumber {
  let out = z.number();
  if (typeof schema.minimum === 'number') out = out.min(schema.minimum);
  if (typeof schema.maximum === 'number') out = out.max(schema.maximum);
  return out;
}

function asObject(value: unknown): JsonSchema | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonSchema)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
