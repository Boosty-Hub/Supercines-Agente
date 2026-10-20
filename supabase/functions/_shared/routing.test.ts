// routing.test.ts — matcher de términos del ruteo de leads.
//   deno test supabase/functions/_shared/routing.test.ts
//
// Se testea la parte pura (elegir persona por término). El round robin vive en
// Postgres (RPC next_round_robin_assignee) y se verifica contra la DB.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { decidirResponsable, matchByTerm, pasaUmbral, type ZonaDePipeline } from "./routing.ts";
import { sinResponsable } from "./zonas.ts";
import { containsTerm, normalizeLoose } from "./text.ts";

const EQUIPO = [
  { kommo_user_id: 1, display_name: "Ana", match_terms: ["La Granja", "Playa Mar"] },
  { kommo_user_id: 2, display_name: "Bea", match_terms: ["Los Aviadores", "Unicentro", "Maracay"] },
  { kommo_user_id: 3, display_name: "Cris", match_terms: ["La Cascada", "Puente Real", "Valencia"] },
];

Deno.test("normalizeLoose saca acentos y mayúsculas", () => {
  assertEquals(normalizeLoose("Cumpleaños  (SÚPER)"), "cumpleanos (super)");
  assertEquals(normalizeLoose("  La   Cascada "), "la cascada");
});

Deno.test("containsTerm exige límites de palabra", () => {
  // El caso que motiva la función: "coro" no puede matchear dentro de otra palabra.
  assertEquals(containsTerm("quiero recordar la fecha", "coro"), false);
  assertEquals(containsTerm("estoy en coro, falcon", "coro"), true);
  assertEquals(containsTerm("sala de la cascada", "la cascada"), true);
});

Deno.test("rutea por sede mencionada en el mensaje", () => {
  const hit = matchByTerm("Hola, quiero información para cumpleaños en la sala de La Cascada", EQUIPO);
  assertEquals(hit?.assignee.kommo_user_id, 3);
  assertEquals(hit?.term, "La Cascada");
});

Deno.test("matchea sin acentos y en minúsculas", () => {
  const hit = matchByTerm("quiero alquilar sala en los aviadores", EQUIPO);
  assertEquals(hit?.assignee.kommo_user_id, 2);
});

Deno.test("sin sede reconocible devuelve null (cae a round robin)", () => {
  assertEquals(matchByTerm("Para el alquiler de una sala", EQUIPO), null);
  assertEquals(matchByTerm("", EQUIPO), null);
});

Deno.test("gana el término más específico, no el primero de la lista", () => {
  const equipo = [
    { kommo_user_id: 1, display_name: "Ana", match_terms: ["Valencia"] },
    { kommo_user_id: 2, display_name: "Bea", match_terms: ["Valencia Norte"] },
  ];
  const hit = matchByTerm("sala en Valencia Norte para un evento", equipo);
  assertEquals(hit?.assignee.kommo_user_id, 2);
});

Deno.test("términos vacíos no matchean nada", () => {
  const equipo = [{ kommo_user_id: 9, display_name: "X", match_terms: ["", "   "] }];
  assertEquals(matchByTerm("cualquier cosa", equipo), null);
});

// ---- Ruteo con zonas y umbral (oct-2026) -------------------------------------------

Deno.test("responsable 0 de Kommo = sin dueño (antes se leía como «ya asignado» y el lead quedaba marcado para siempre)", () => {
  assertEquals(sinResponsable(0), true);
  assertEquals(sinResponsable(null), true);
  assertEquals(sinResponsable(10668935), false);
});

Deno.test("umbral: un término exacto de sede rutea aunque la confianza sea baja; sin término rige el umbral", () => {
  assertEquals(pasaUmbral(0.8, 0.45, true), true);
  assertEquals(pasaUmbral(0.8, null, true), true);
  assertEquals(pasaUmbral(0.8, 0.45, false), false);
  assertEquals(pasaUmbral(0.8, null, false), false);
  assertEquals(pasaUmbral(0.8, 0.8, false), true);
  assertEquals(pasaUmbral(0, null, false), true);
});

const ZONAS_PIPE = new Map<number, ZonaDePipeline>([
  [7847207, { userId: 3, zona: "CCS", pipelineName: "Ventas Zona CCS" }],
  [8028895, { userId: 1, zona: "VAL", pipelineName: "Ventas Zona VAL" }],
]);

Deno.test("decidirResponsable: el término gana; sin término, la asesora del embudo de zona; si no, round robin", () => {
  const hit = matchByTerm("cumpleaños en Los Aviadores", EQUIPO);
  assertEquals(decidirResponsable(hit, 8028895, ZONAS_PIPE), { strategy: "term_match", userId: 2, matchedTerm: "Los Aviadores" });
  assertEquals(decidirResponsable(null, 8028895, ZONAS_PIPE), { strategy: "term_match", userId: 1, matchedTerm: "embudo Ventas Zona VAL" });
  assertEquals(decidirResponsable(null, 7847023, ZONAS_PIPE), { strategy: "round_robin" });
  assertEquals(decidirResponsable(null, null, ZONAS_PIPE), { strategy: "round_robin" });
});
