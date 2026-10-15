// Tests del helper único de body (lib/api/body.ts): todo body inválido es 400 (o 413) con un
// mensaje claro en español y SIN el valor enviado; todo body válido llega como data tipada.
// Correr con: cd web && node --test src/lib/api-body.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  BODY_TOO_LARGE,
  INVALID_BODY,
  MAX_BODY_BYTES,
  describeIssue,
  readForm,
  readJson,
} from "./api/body.ts";

const SECRET = "sk-ant-api03-SECRETO-QUE-NO-DEBE-SALIR";
const URL_ = "http://localhost/api/x";

function jsonReq(body: BodyInit | null, contentType: string | null = "application/json", extra: HeadersInit = {}) {
  const headers = new Headers(extra);
  if (contentType !== null) headers.set("content-type", contentType);
  return new Request(URL_, { method: "POST", body, headers });
}

const Obj = z.object({
  name: z.string().min(1),
  kind: z.enum(["a", "b"]).optional(),
  count: z.number().int().min(0).optional(),
  api_key: z.string().optional(),
});

async function expectError(
  res: Awaited<ReturnType<typeof readJson>>,
  status: number,
  pattern: RegExp
): Promise<string> {
  assert.equal(res.ok, false, "se esperaba un error");
  if (res.ok) throw new Error("unreachable");
  assert.equal(res.response.status, status);
  const body = (await res.response.json()) as { error: string; code: string };
  assert.equal(body.code, status === 413 ? BODY_TOO_LARGE : INVALID_BODY);
  assert.match(body.error, pattern);
  assert.ok(!body.error.includes(SECRET), `el mensaje filtró el valor enviado: ${body.error}`);
  assert.ok(!body.error.includes("SECRETO"), `el mensaje filtró el valor enviado: ${body.error}`);
  return body.error;
}

// ---------------------------------------------------------------------------------------------
// readJson: tabla de bodies inválidos
// ---------------------------------------------------------------------------------------------
const INVALID_JSON: { name: string; req: () => Request; status: number; pattern: RegExp }[] = [
  { name: "JSON roto", req: () => jsonReq(`{"name": "${SECRET}"`), status: 400, pattern: /no es JSON válido/ },
  { name: "cuerpo vacío", req: () => jsonReq(""), status: 400, pattern: /Falta el cuerpo/ },
  { name: "sin body", req: () => jsonReq(null), status: 400, pattern: /Falta el cuerpo/ },
  { name: "solo espacios", req: () => jsonReq("   \n "), status: 400, pattern: /Falta el cuerpo/ },
  { name: "array donde se espera objeto", req: () => jsonReq(`["${SECRET}"]`), status: 400, pattern: /El cuerpo debe ser un objeto/ },
  { name: "string donde se espera objeto", req: () => jsonReq(`"${SECRET}"`), status: 400, pattern: /El cuerpo debe ser un objeto/ },
  { name: "null donde se espera objeto", req: () => jsonReq("null"), status: 400, pattern: /El cuerpo debe ser un objeto/ },
  { name: "número donde se espera objeto", req: () => jsonReq("42"), status: 400, pattern: /El cuerpo debe ser un objeto/ },
  {
    name: "content-type de formulario",
    req: () => jsonReq(`name=${SECRET}`, "application/x-www-form-urlencoded"),
    status: 400,
    pattern: /espera JSON, no un formulario/,
  },
  {
    name: "content-type multipart",
    req: () => {
      const fd = new FormData();
      fd.set("name", SECRET);
      return new Request(URL_, { method: "POST", body: fd });
    },
    status: 400,
    pattern: /espera JSON, no un formulario/,
  },
  { name: "text/plain con JSON", req: () => jsonReq(`{"name":"${SECRET}"}`, "text/plain"), status: 400, pattern: /espera JSON/ },
  { name: "sin content-type", req: () => jsonReq(`{"name":"${SECRET}"}`, null), status: 400, pattern: /espera JSON/ },
  { name: "falta campo requerido", req: () => jsonReq(`{"api_key":"${SECRET}"}`), status: 400, pattern: /Falta el campo «name»/ },
  { name: "tipo equivocado", req: () => jsonReq(`{"name": 5, "api_key":"${SECRET}"}`), status: 400, pattern: /«name» debe ser un texto/ },
  { name: "enum inválido (zod incluiría el valor)", req: () => jsonReq(`{"name":"x","kind":"${SECRET}"}`), status: 400, pattern: /«kind» no es un valor permitido \(opciones: a, b\)/ },
  { name: "string vacío en min(1)", req: () => jsonReq(`{"name":""}`), status: 400, pattern: /«name» no puede estar vacío/ },
  { name: "número negativo", req: () => jsonReq(`{"name":"x","count":-1}`), status: 400, pattern: /«count» debe ser mayor o igual a 0/ },
  { name: "no entero", req: () => jsonReq(`{"name":"x","count":1.5}`), status: 400, pattern: /«count» debe ser un número entero/ },
  { name: "UTF-8 inválido", req: () => jsonReq(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])), status: 400, pattern: /UTF-8/ },
  {
    name: "tamaño excesivo (stream, sin Content-Length)",
    req: () => jsonReq(JSON.stringify({ name: "x".repeat(MAX_BODY_BYTES + 10) })),
    status: 413,
    pattern: /supera el máximo permitido \(1 MB\)/,
  },
  {
    name: "Content-Length declarado excesivo",
    req: () => jsonReq(`{"name":"x"}`, "application/json", { "content-length": String(MAX_BODY_BYTES + 1) }),
    status: 413,
    pattern: /supera el máximo/,
  },
];

for (const c of INVALID_JSON) {
  test(`readJson inválido → ${c.status}: ${c.name}`, async () => {
    await expectError(await readJson(c.req(), Obj), c.status, c.pattern);
  });
}

test("readJson: un stream que se corta da 400, no tira", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"name":'));
      controller.error(new Error("socket hang up"));
    },
  });
  const req = new Request(URL_, {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    duplex: "half",
  } as RequestInit);
  await expectError(await readJson(req, Obj), 400, /No se pudo leer/);
});

test("readJson: un body ya consumido da 400, no tira", async () => {
  const req = jsonReq(`{"name":"x"}`);
  await req.text();
  await expectError(await readJson(req, Obj), 400, /No se pudo leer/);
});

test("readJson: maxBytes propio", async () => {
  await expectError(await readJson(jsonReq(`{"name":"${"x".repeat(200)}"}`), Obj, { maxBytes: 100 }), 413, /supera/);
});

// ---------------------------------------------------------------------------------------------
// readJson: bodies válidos
// ---------------------------------------------------------------------------------------------
test("readJson válido → data tipada y sin campos que el schema no declara", async () => {
  const res = await readJson(jsonReq(`{"name":"Ana","kind":"b","count":2,"extra":true}`), Obj);
  assert.deepEqual(res, { ok: true, data: { name: "Ana", kind: "b", count: 2 } });
});

test("readJson acepta charset y +json", async () => {
  assert.equal((await readJson(jsonReq(`{"name":"x"}`, "application/json; charset=utf-8"), Obj)).ok, true);
  assert.equal((await readJson(jsonReq(`{"name":"x"}`, "Application/JSON"), Obj)).ok, true);
  assert.equal((await readJson(jsonReq(`{"name":"x"}`, "application/merge-patch+json"), Obj)).ok, true);
});

test("readJson optional: body vacío (sin content-type) → valida {}", async () => {
  const S = z.object({ force: z.boolean().optional() });
  assert.deepEqual(await readJson(jsonReq(null, null), S, { optional: true }), { ok: true, data: {} });
  assert.deepEqual(await readJson(jsonReq("", "text/plain"), S, { optional: true }), { ok: true, data: {} });
  assert.deepEqual(await readJson(jsonReq(`{"force":true}`), S, { optional: true }), { ok: true, data: { force: true } });
  // optional no relaja lo demás: un body presente y roto sigue siendo 400.
  await expectError(await readJson(jsonReq("{nope"), S, { optional: true }), 400, /no es JSON válido/);
  await expectError(await readJson(jsonReq(`{"force":"sí"}`), S, { optional: true }), 400, /«force» debe ser verdadero o falso/);
});

test("readJson con schema no-objeto (z.unknown) recibe el valor tal cual", async () => {
  assert.deepEqual(await readJson(jsonReq("[1,2]"), z.unknown()), { ok: true, data: [1, 2] });
});

// ---------------------------------------------------------------------------------------------
// readForm
// ---------------------------------------------------------------------------------------------
const Form = z.object({ webhook_url: z.string().optional(), webhook_enabled: z.string().optional() });

test("readForm urlencoded válido → primer valor de cada campo", async () => {
  const req = new Request(URL_, {
    method: "POST",
    body: new URLSearchParams([["webhook_url", "https://x"], ["webhook_url", "https://y"], ["webhook_enabled", "on"]]),
  });
  assert.deepEqual(await readForm(req, Form), { ok: true, data: { webhook_url: "https://x", webhook_enabled: "on" } });
});

test("readForm multipart con archivo", async () => {
  const fd = new FormData();
  fd.set("title", "Doc");
  fd.set("file", new File(["hola"], "a.txt", { type: "text/plain" }));
  const S = z.object({ title: z.string(), file: z.instanceof(File) });
  const res = await readForm(new Request(URL_, { method: "POST", body: fd }), S);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.data.title, "Doc");
    assert.equal(await res.data.file.text(), "hola");
  }
});

test("readForm: JSON → 400 claro sin el valor", async () => {
  await expectError(await readForm(jsonReq(`{"webhook_url":"${SECRET}"}`), Form), 400, /espera un formulario, no JSON/);
});

test("readForm: sin content-type / text/plain → 400", async () => {
  await expectError(await readForm(jsonReq(`webhook_url=${SECRET}`, null), Form), 400, /espera un formulario/);
  await expectError(await readForm(jsonReq(`webhook_url=${SECRET}`, "text/plain"), Form), 400, /espera un formulario/);
});

test("readForm: multipart roto (boundary inexistente) → 400", async () => {
  const req = jsonReq(`--zzz\r\nContent-Disposition: form-data; name="a"\r\n\r\n${SECRET}`, "multipart/form-data; boundary=otra");
  await expectError(await readForm(req, Form), 400, /formulario está mal formado/);
});

test("readForm: multipart sin boundary → 400", async () => {
  await expectError(await readForm(jsonReq("x", "multipart/form-data"), Form), 400, /mal formado/);
});

test("readForm: tipo equivocado (archivo donde va texto) → 400", async () => {
  const fd = new FormData();
  fd.set("webhook_url", new File([SECRET], "s.txt"));
  await expectError(await readForm(new Request(URL_, { method: "POST", body: fd }), Form), 400, /«webhook_url» debe ser un texto/);
});

test("readForm: tamaño excesivo → 413", async () => {
  const req = new Request(URL_, { method: "POST", body: new URLSearchParams({ webhook_url: "x".repeat(2000) }) });
  await expectError(await readForm(req, Form, { maxBytes: 1000 }), 413, /supera el máximo/);
});

test("readForm: urlencoded vacío → objeto vacío (el schema decide)", async () => {
  const req = jsonReq("", "application/x-www-form-urlencoded");
  assert.deepEqual(await readForm(req, Form), { ok: true, data: {} });
});

// ---------------------------------------------------------------------------------------------
// describeIssue: nunca el valor recibido
// ---------------------------------------------------------------------------------------------
test("describeIssue no incluye el valor en ningún código de error de zod", () => {
  const S = z.object({
    a: z.enum(["x"]),
    b: z.literal("ok"),
    c: z.string().url(),
    d: z.string().max(3),
    e: z.union([z.number(), z.boolean()]),
    f: z.string().refine(() => false),
  });
  const bad = { a: SECRET, b: SECRET, c: SECRET, d: SECRET, e: SECRET, f: SECRET };
  const r = S.safeParse(bad);
  assert.equal(r.success, false);
  if (r.success) return;
  assert.ok(r.error.issues.length >= 6);
  for (const issue of r.error.issues) {
    const msg = describeIssue(issue);
    assert.ok(!msg.includes("SECRETO"), `filtró el valor: ${msg}`);
    assert.match(msg, new RegExp(`«${issue.path.join(".")}»`));
  }
});
