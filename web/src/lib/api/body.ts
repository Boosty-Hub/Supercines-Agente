// Lectura ÚNICA del body de las rutas de API (`app/api/**/route.ts`).
//
// Ninguna ruta lee el body a mano (`request.json()`, `request.formData()`, `request.text()`):
// un body inválido daba 500 (SyntaxError/TypeError sin atrapar) en vez de 400. Acá se centraliza
// TODO lo que puede salir mal antes de que la ruta vea los datos:
//   - cuerpo vacío o ilegible (stream cortado, UTF-8 inválido),
//   - content-type que no corresponde (JSON a una ruta de formulario y viceversa),
//   - JSON mal formado, body que no es objeto cuando se espera uno, tipos equivocados (zod),
//   - tamaño excesivo (413) — se corta al leer, no se confía solo en Content-Length.
// Guardia de código: `lib/api-body-guard.test.ts` falla si un route.ts vuelve a leer el body
// sin pasar por acá.
//
// Puro (sin imports de servidor): sirve en `api/provision/**` (invariante de /first-run) y se
// testea con `Request` estándar. Devuelve `Response` (Next acepta cualquier Response en un route
// handler); el mensaje de error NUNCA incluye valores del body (pueden ser secretos), solo el
// nombre del campo y qué se esperaba.
import { z, type ZodIssue, type ZodTypeAny } from "zod";

/** Límite por defecto de un body JSON / formulario sin archivos. */
export const MAX_BODY_BYTES = 1_000_000;
/** Archivo máximo de las subidas (KB y voz): lo que la UI promete («Máx 5 MB»). */
export const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024;
/** Body máximo de un multipart con archivo: el archivo + margen para los campos y el framing. */
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_FILE_BYTES + 512 * 1024;

/** Campo de archivo de una subida (readForm con `maxBytes: MAX_UPLOAD_BODY_BYTES`). */
export const uploadFile = z
  .instanceof(File, { message: "El campo «file» debe ser un archivo." })
  .refine((f) => f.size <= MAX_UPLOAD_FILE_BYTES, {
    message: `El archivo supera el máximo de ${MAX_UPLOAD_FILE_BYTES / (1024 * 1024)} MB.`,
  });

export const INVALID_BODY = "invalid_body";
export const BODY_TOO_LARGE = "body_too_large";

export type BodyResult<T> = { ok: true; data: T } | { ok: false; response: Response };

export type ReadOptions = {
  /** Bytes máximos del body (default `MAX_BODY_BYTES`). Pasado el límite → 413. */
  maxBytes?: number;
};

export type ReadJsonOptions = ReadOptions & {
  /**
   * Body vacío permitido: se valida `{}` contra el schema (rutas que se llaman con un POST
   * sin cuerpo, p. ej. «correr ahora»). Sin esto, un body vacío es 400.
   */
  optional?: boolean;
};

function fail(status: 400 | 413, error: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: Response.json({ error, code: status === 413 ? BODY_TOO_LARGE : INVALID_BODY }, { status }),
  };
}

function tooLarge(max: number) {
  return fail(413, `El cuerpo de la solicitud supera el máximo permitido (${formatBytes(max)}).`);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10} MB`;
  return `${Math.round(n / 1000)} KB`;
}

/** Media type sin parámetros, en minúsculas (`"application/json; charset=utf-8"` → `"application/json"`). */
export function mediaType(request: Request): string {
  return (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

function isJsonType(t: string): boolean {
  return t === "application/json" || (t.startsWith("application/") && t.endsWith("+json"));
}

function isFormType(t: string): boolean {
  return t === "application/x-www-form-urlencoded" || t === "multipart/form-data";
}

type Bytes = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; response: Response };

/** Lee el body entero cortando apenas supera `max` (no se confía en Content-Length). */
async function readBytes(request: Request, max: number): Promise<Bytes> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > max) return tooLarge(max);
  if (request.bodyUsed) return fail(400, "No se pudo leer el cuerpo de la solicitud.");
  if (!request.body) return { ok: true, bytes: new Uint8Array(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return tooLarge(max);
      }
      chunks.push(value);
    }
  } catch {
    return fail(400, "No se pudo leer el cuerpo de la solicitud.");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, bytes };
}

const TYPE_ES: Record<string, string> = {
  string: "un texto",
  number: "un número",
  integer: "un número entero",
  bigint: "un número entero",
  boolean: "verdadero o falso",
  object: "un objeto",
  array: "una lista",
  date: "una fecha",
  null: "nulo",
  undefined: "omitido",
};

function fieldName(path: (string | number)[]): string {
  return path.length === 0 ? "" : path.map(String).join(".");
}

/**
 * Mensaje legible del primer error de zod, SIN el valor recibido (los mensajes por defecto de
 * zod sí lo incluyen, p. ej. «received 'sk-ant-…'» en un enum). Exportado para los tests.
 */
export function describeIssue(issue: ZodIssue): string {
  const name = fieldName(issue.path);
  const subject = name ? `El campo «${name}»` : "El cuerpo";
  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined" && name) return `Falta el campo «${name}».`;
      if (issue.received === "undefined") return "Falta el cuerpo de la solicitud.";
      return `${subject} debe ser ${TYPE_ES[issue.expected] ?? "de otro tipo"}.`;
    case "invalid_enum_value":
      return `${subject} no es un valor permitido (opciones: ${issue.options.map(String).join(", ")}).`;
    case "invalid_literal":
      return `${subject} no tiene el valor esperado.`;
    case "too_small":
      if (issue.type === "string") {
        return Number(issue.minimum) <= 1 ? `${subject} no puede estar vacío.` : `${subject} debe tener al menos ${issue.minimum} caracteres.`;
      }
      if (issue.type === "array" || issue.type === "set") return `${subject} debe tener al menos ${issue.minimum} elemento(s).`;
      return `${subject} debe ser ${issue.inclusive ? "mayor o igual a" : "mayor que"} ${issue.minimum}.`;
    case "too_big":
      if (issue.type === "string") return `${subject} supera el máximo de ${issue.maximum} caracteres.`;
      if (issue.type === "array" || issue.type === "set") return `${subject} supera el máximo de ${issue.maximum} elemento(s).`;
      return `${subject} debe ser ${issue.inclusive ? "menor o igual a" : "menor que"} ${issue.maximum}.`;
    case "invalid_string":
      return `${subject} no tiene un formato válido.`;
    case "not_multiple_of":
    case "not_finite":
      return `${subject} no es un número válido.`;
    case "unrecognized_keys":
      return `${subject} tiene campos no reconocidos.`;
    case "custom":
    case "invalid_union":
      // Los mensajes de refine/superRefine/errorMap los escribe el schema de la ruta (nunca con el
      // valor); el default de zod para estos dos códigos es «Invalid input», sin el valor.
      return issue.message && issue.message !== "Invalid input" ? issue.message : `${subject} no es válido.`;
    default:
      return `${subject} no es válido.`;
  }
}

function validate<S extends ZodTypeAny>(schema: S, value: unknown): BodyResult<z.output<S>> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  return fail(400, describeIssue(parsed.error.issues[0]));
}

/**
 * Lee y valida un body JSON. 400 si: falta y no es `optional`, el content-type no es JSON, no es
 * UTF-8, no parsea o no cumple el schema. 413 si supera `maxBytes`.
 */
export async function readJson<S extends ZodTypeAny>(
  request: Request,
  schema: S,
  options: ReadJsonOptions = {}
): Promise<BodyResult<z.output<S>>> {
  const max = options.maxBytes ?? MAX_BODY_BYTES;
  const read = await readBytes(request, max);
  if (!read.ok) return read;

  if (read.bytes.byteLength === 0) {
    if (options.optional) return validate(schema, {});
    return fail(400, "Falta el cuerpo de la solicitud (se esperaba JSON).");
  }

  const type = mediaType(request);
  if (!isJsonType(type)) {
    return fail(
      400,
      isFormType(type)
        ? "Esta ruta espera JSON, no un formulario (Content-Type: application/json)."
        : "Esta ruta espera JSON (Content-Type: application/json)."
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
  } catch {
    return fail(400, "El cuerpo no es texto UTF-8 válido.");
  }
  if (!text.trim()) {
    if (options.optional) return validate(schema, {});
    return fail(400, "Falta el cuerpo de la solicitud (se esperaba JSON).");
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(400, "El cuerpo no es JSON válido.");
  }
  return validate(schema, value);
}

/** Valor de un campo de formulario tal como lo da `FormData.get` (el primero si se repite). */
export type FormValue = string | File;

/**
 * Lee y valida un formulario (`application/x-www-form-urlencoded` o `multipart/form-data`; ambos
 * son FormData, se aceptan los dos). JSON u otro content-type → 400. El schema recibe un objeto
 * `{ campo: valor }` con el PRIMER valor de cada campo (misma semántica que `form.get`).
 */
export async function readForm<S extends ZodTypeAny>(
  request: Request,
  schema: S,
  options: ReadOptions = {}
): Promise<BodyResult<z.output<S>>> {
  const max = options.maxBytes ?? MAX_BODY_BYTES;
  const type = mediaType(request);
  if (!isFormType(type)) {
    return fail(
      400,
      isJsonType(type)
        ? "Esta ruta espera un formulario, no JSON (multipart/form-data o application/x-www-form-urlencoded)."
        : "Esta ruta espera un formulario (multipart/form-data o application/x-www-form-urlencoded)."
    );
  }

  const read = await readBytes(request, max);
  if (!read.ok) return read;

  let form: FormData;
  try {
    // Se re-arma la Request con los bytes ya leídos (con el límite aplicado) para que el parser
    // estándar resuelva el multipart; un boundary roto o un multipart truncado tira → 400.
    form = await new Response(read.bytes, {
      headers: { "content-type": request.headers.get("content-type") ?? type },
    }).formData();
  } catch {
    return fail(400, "El formulario está mal formado.");
  }

  const fields: Record<string, FormValue> = {};
  for (const [key, value] of form.entries()) {
    if (!(key in fields)) fields[key] = value;
  }
  return validate(schema, fields);
}
