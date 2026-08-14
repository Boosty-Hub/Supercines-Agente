// routing.test.ts — matcher de términos del ruteo de leads.
//   deno test supabase/functions/_shared/routing.test.ts
//
// Se testea la parte pura (elegir persona por término). El round robin vive en
// Postgres (RPC next_round_robin_assignee) y se verifica contra la DB.

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { matchByTerm } from "./routing.ts";
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
