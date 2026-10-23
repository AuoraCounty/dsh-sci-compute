export function validate(schema, value, path = "$") {
  const errors = [];
  check(schema ?? {}, value, path, errors);
  return errors;
}

function check(schema, value, path, errors) {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const ok = schema.oneOf.some((item) => validate(item, value, path).length === 0);
    if (!ok) errors.push(`${path} does not match schema`);
    return;
  }
  if (schema.type) {
    if (!typeOk(schema.type, value)) {
      errors.push(`${path} must be ${schema.type}`);
      return;
    }
  }
  if (typeof schema.minimum === "number" && typeof value === "number" && value < schema.minimum) {
    errors.push(`${path} is below ${schema.minimum}`);
  }
  if (typeof schema.maximum === "number" && typeof value === "number" && value > schema.maximum) {
    errors.push(`${path} is above ${schema.maximum}`);
  }
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) check(props[key], child, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
  }
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => check(schema.items, item, `${path}[${index}]`, errors));
  }
}

function typeOk(type, value) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "null") return value === null;
  return true;
}
