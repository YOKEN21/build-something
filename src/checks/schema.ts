import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { readFileSync } from "node:fs";

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

const compiled = new WeakMap<object, ValidateFunction>();

function validatorFor(schema: object): ValidateFunction {
  const existing = compiled.get(schema);
  if (existing) {
    return existing;
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  compiled.set(schema, validate);
  return validate;
}

function formatError(error: ErrorObject): string {
  const at = error.instancePath.length > 0 ? error.instancePath : "/";
  return `${at} ${error.message ?? "invalid"}`;
}

export function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
}

export function assertSchemaCompiles(schema: object): void {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.compile(schema);
}

export function validateInstance(schema: object, data: unknown): ValidationResult {
  const validate = validatorFor(schema);
  const ok = validate(data);
  if (ok === true) {
    return { ok: true, errors: [] };
  }
  return {
    ok: false,
    errors: (validate.errors ?? []).map(formatError),
  };
}
