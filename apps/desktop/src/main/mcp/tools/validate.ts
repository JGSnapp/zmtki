/**
 * Minimal JSON-Schema validation for tool arguments. Models frequently send
 * numbers as strings, so scalars are coerced before being rejected.
 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value: Record<string, unknown>;
}

const coerce = (schema: Record<string, unknown>, value: unknown, path: string, errors: string[]): unknown => {
  const type = schema.type as string | undefined;
  if (value == null) return value;

  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errors.push(`${path}: expected one of ${schema.enum.join(', ')}, got ${JSON.stringify(value)}`);
    return value;
  }

  switch (type) {
    case 'number':
    case 'integer': {
      const parsed = typeof value === 'string' ? Number(value) : value;
      if (typeof parsed !== 'number' || Number.isNaN(parsed)) {
        errors.push(`${path}: expected number, got ${JSON.stringify(value)}`);
        return value;
      }
      return type === 'integer' ? Math.round(parsed) : parsed;
    }
    case 'boolean': {
      if (typeof value === 'string') return value === 'true';
      if (typeof value !== 'boolean') {
        errors.push(`${path}: expected boolean`);
      }
      return value;
    }
    case 'string': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      errors.push(`${path}: expected string`);
      return value;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return value;
      }
      const items = schema.items as Record<string, unknown> | undefined;
      return items ? value.map((v, i) => coerce(items, v, `${path}[${i}]`, errors)) : value;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return value;
      }
      return validateAgainst(schema, value as Record<string, unknown>, path, errors);
    }
    default:
      return value;
  }
};

const validateAgainst = (
  schema: Record<string, unknown>,
  input: Record<string, unknown>,
  path: string,
  errors: string[],
): Record<string, unknown> => {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (schema.required ?? []) as string[];
  const out: Record<string, unknown> = {};

  for (const key of required) {
    if (input[key] === undefined || input[key] === null) {
      errors.push(`${path}${path ? '.' : ''}${key}: required`);
    }
  }
  for (const [key, value] of Object.entries(input)) {
    const propSchema = properties[key];
    out[key] = propSchema
      ? coerce(propSchema, value, `${path}${path ? '.' : ''}${key}`, errors)
      : value;
  }
  return out;
};

export const validateArgs = (
  schema: Record<string, unknown>,
  input: unknown,
): ValidationResult => {
  const errors: string[] = [];
  const source =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const value = validateAgainst(schema, source, '', errors);
  return { ok: errors.length === 0, errors, value };
};
