// Correr con: deno test supabase/functions/_shared/classify-recovery.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { expiredClassificationUpdate, RECOVER_FALLBACK_MAX_AGE_HOURS, recoverWindowHours } from "./classify-recovery.ts";

Deno.test("recoverWindowHours: answer_max_age_hours manda; 0 = tope de respaldo de 24 h", () => {
  assertEquals(recoverWindowHours(1), 1);
  assertEquals(recoverWindowHours(6), 6);
  assertEquals(recoverWindowHours(0), RECOVER_FALLBACK_MAX_AGE_HOURS);
});

Deno.test("al vencer la ventana: revisión humana y error explícito que lo saca del select (prefijo recover:)", () => {
  const u = expiredClassificationUpdate({ error: "classify: overloaded", recover_attempts: 2 }, 1);
  assertEquals(u.requires_human_review, true);
  assert(String(u.classification.error).startsWith("recover:"));
  assert(String(u.classification.error).includes("overloaded"));
  assertEquals(u.classification.recover_attempts, 2); // conserva lo previo
  assertEquals(u.classification.recover_expired, true);
});

Deno.test("clasificación previa ausente o rara no rompe", () => {
  for (const prev of [null, undefined, "x", 3]) {
    const u = expiredClassificationUpdate(prev, 24);
    assertEquals(u.requires_human_review, true);
    assert(String(u.classification.error).includes("desconocido"));
  }
});
