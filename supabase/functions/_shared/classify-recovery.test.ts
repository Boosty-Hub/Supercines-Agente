// Correr con: deno test supabase/functions/_shared/classify-recovery.test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import {
  EXPIRED_ALERT_SOURCE,
  expiredAlertPlan,
  expiredClassificationUpdate,
  expireSelectionRange,
  RECOVER_EXPIRE_GRACE_DAYS,
  RECOVER_FALLBACK_MAX_AGE_HOURS,
  recoverWindowHours,
} from "./classify-recovery.ts";

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

const H = 3_600_000;
const NOW = Date.parse("2026-10-13T12:00:00Z");
const inRange = (createdMs: number, r: { fromIso: string; toIso: string }) =>
  createdMs >= Date.parse(r.fromIso) && createdMs < Date.parse(r.toIso);

Deno.test("expireSelectionRange: solo la franja [ahora - ventana - 3 días, ahora - ventana)", () => {
  const r = expireSelectionRange(NOW, 6);
  assertEquals(r.toIso, new Date(NOW - 6 * H).toISOString());
  assertEquals(r.fromIso, new Date(NOW - 6 * H - RECOVER_EXPIRE_GRACE_DAYS * 24 * H).toISOString());
});

Deno.test("expireSelectionRange: dentro de la ventana NO vence; recién vencido SÍ; histórico viejo se ignora", () => {
  const r = expireSelectionRange(NOW, 6);
  assertEquals(inRange(NOW - 5 * H, r), false, "todavía dentro de la ventana de recuperación");
  assertEquals(inRange(NOW - 6 * H - 1, r), true, "recién vencido");
  assertEquals(inRange(NOW - 2 * 24 * H, r), true, "vencido hace 2 días (cron caído un fin de semana)");
  assertEquals(inRange(NOW - 6 * H - RECOVER_EXPIRE_GRACE_DAYS * 24 * H - 1, r), false, "más viejo que la gracia");
  assertEquals(inRange(NOW - 90 * 24 * H, r), false, "histórico del rollout: no se toca");
});

Deno.test("expireSelectionRange: con la ventana de respaldo (24 h) también acota", () => {
  const r = expireSelectionRange(NOW, recoverWindowHours(0));
  assertEquals(inRange(NOW - 23 * H, r), false);
  assertEquals(inRange(NOW - 25 * H, r), true);
  assertEquals(inRange(NOW - (24 + 72) * H - 1, r), false);
});

Deno.test("expiredAlertPlan: sin alerta reciente sin reconocer → inserta UNA con la marca de fuente", () => {
  const p = expiredAlertPlan(null, 3, 6);
  assertEquals(p.action, "insert");
  if (p.action !== "insert") return;
  assertEquals(p.row.kind, "human_review_needed");
  assertEquals(p.row.metadata, { source: EXPIRED_ALERT_SOURCE, expired: 3, window_hours: 6 });
  assert(p.row.title.startsWith("3 mensaje(s)"));
});

Deno.test("expiredAlertPlan: con una alerta reciente sin reconocer → la actualiza sumando (no inserta otra)", () => {
  const p = expiredAlertPlan({ id: "a1", metadata: { source: EXPIRED_ALERT_SOURCE, expired: 4, window_hours: 6 } }, 2, 6);
  assertEquals(p.action, "update");
  if (p.action !== "update") return;
  assertEquals(p.id, "a1");
  assertEquals(p.patch.metadata.expired, 6);
  assert(p.patch.title.startsWith("6 mensaje(s)"));
});

Deno.test("expiredAlertPlan: metadata previa rara no rompe (cuenta desde 0)", () => {
  for (const metadata of [null, "x", { expired: "NaN" }, { expired: -3 }]) {
    const p = expiredAlertPlan({ id: "a1", metadata }, 2, 6);
    assertEquals(p.action === "update" && p.patch.metadata.expired, 2);
  }
});
