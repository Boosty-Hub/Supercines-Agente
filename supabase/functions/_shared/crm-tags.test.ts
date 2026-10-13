// _shared/crm-tags.test.ts
// Deno tests para la normalización pura de `etiquetar_lead`: parseo tolerante
// de la entrada y el cálculo ADITIVO (nunca pisa, nunca duplica).
//
// Correr con: deno test --allow-read supabase/functions/_shared/crm-tags.test.ts

import { assertEquals } from "jsr:@std/assert@^1.0.0";
import { calcularEtiquetasNuevas, parseEtiquetas } from "./crm-tags.ts";

// ---- parseEtiquetas ----

Deno.test("parseEtiquetas: array normal, recorta y saca vacíos", () => {
  assertEquals(parseEtiquetas([" VIP ", "urgente", "", "  "]), ["VIP", "urgente"]);
});

Deno.test("parseEtiquetas: string suelto separado por coma o punto y coma (alucinación de formato)", () => {
  assertEquals(parseEtiquetas("vip, urgente;  moroso "), ["vip", "urgente", "moroso"]);
});

Deno.test("parseEtiquetas: undefined/null no rompe, devuelve lista vacía", () => {
  assertEquals(parseEtiquetas(undefined), []);
  assertEquals(parseEtiquetas(null), []);
});

// ---- calcularEtiquetasNuevas ----

Deno.test("calcularEtiquetasNuevas: aditiva — no reporta las que ya existen", () => {
  const existentes = [{ id: 1, name: "VIP" }];
  assertEquals(calcularEtiquetasNuevas(existentes, ["VIP", "urgente"]), ["urgente"]);
});

Deno.test("calcularEtiquetasNuevas: coincidencia case-insensitive con lo existente", () => {
  const existentes = [{ id: 1, name: "vip" }];
  assertEquals(calcularEtiquetasNuevas(existentes, ["VIP", "Vip", "urgente"]), ["urgente"]);
});

Deno.test("calcularEtiquetasNuevas: no duplica entre las propias candidatas", () => {
  assertEquals(calcularEtiquetasNuevas([], ["urgente", "Urgente", "URGENTE"]), ["urgente"]);
});

Deno.test("calcularEtiquetasNuevas: sin existentes, todas las candidatas válidas se agregan", () => {
  assertEquals(calcularEtiquetasNuevas([], ["a", "b"]), ["a", "b"]);
});

Deno.test("calcularEtiquetasNuevas: todo ya existe → lista vacía (no-op)", () => {
  const existentes = [{ id: 1, name: "vip" }, { id: 2, name: "urgente" }];
  assertEquals(calcularEtiquetasNuevas(existentes, ["VIP", "urgente"]), []);
});
