// Correr con: deno test supabase/functions/_shared/alert-webhook.test.ts
// El aviso al webhook no puede mencionar a nadie ni pintar links que no escribimos, aunque el
// título traiga el display_name del lead.
import { assert, assertEquals } from "jsr:@std/assert@^1.0.0";
import { buildWebhookPayload, escapeSlack, isMissingClaimRpc, neutralizeDiscord, repeatedSuffix } from "./alert-webhook.ts";

const ZWSP = "​";

Deno.test("Slack: se escapan &, < y > (sin <!channel>, <@U…> ni links <url|texto> ajenos)", () => {
  assertEquals(escapeSlack("<!channel> hola"), "&lt;!channel&gt; hola");
  assertEquals(escapeSlack("<@U123ABC>"), "&lt;@U123ABC&gt;");
  assertEquals(escapeSlack("<https://evil.example|Kommo>"), "&lt;https://evil.example|Kommo&gt;");
  assertEquals(escapeSlack("a & b &amp;"), "a &amp; b &amp;amp;");
});

Deno.test("Discord: @everyone/@here, <@…>, <#…> y [texto](url) quedan cortados", () => {
  assertEquals(neutralizeDiscord("@everyone y @Here"), `@${ZWSP}everyone y @${ZWSP}Here`);
  assertEquals(neutralizeDiscord("<@123> <@&456> <#789>"), `<${ZWSP}@123> <${ZWSP}@&456> <${ZWSP}#789>`);
  assertEquals(neutralizeDiscord("[Kommo](https://evil.example)"), `[Kommo]${ZWSP}(https://evil.example)`);
  assertEquals(neutralizeDiscord("texto normal: 3 < 4 & 5 > 2"), "texto normal: 3 < 4 & 5 > 2");
});

Deno.test("payload con un display_name hostil: ni Slack ni Discord reciben una mención o link activo", () => {
  const p = buildWebhookPayload({
    severity: "critical",
    title: "Draft falló: <!channel> @everyone [x](https://evil.example)",
    description: "<@U999> <https://evil.example|Kommo> @here",
  });
  assert(!/<!channel>|<@U999>|<https:/.test(p.text), p.text);
  assert(p.text.includes("&lt;!channel&gt;"));
  const e = p.embeds[0];
  for (const s of [e.title, e.description]) {
    assert(!/@everyone|@here|<@U|\]\(/.test(s), s);
  }
  assertEquals(p.allowed_mentions, { parse: [] });
  assert(p.text.startsWith("🚨 *"));
});

Deno.test("«(+N repetidas)» cuando el barrido suprimió idénticas", () => {
  assertEquals(repeatedSuffix(0), "");
  assertEquals(repeatedSuffix(undefined), "");
  assertEquals(repeatedSuffix(1), " (+1 repetida)");
  assertEquals(repeatedSuffix(4), " (+4 repetidas)");
  const p = buildWebhookPayload({ severity: "warning", title: "No confirmado", description: "d", repeated: 3 });
  assert(p.text.startsWith("⚠️ *No confirmado (+3 repetidas)*"), p.text);
  assertEquals(p.embeds[0].title, "⚠️ No confirmado (+3 repetidas)");
});

Deno.test("títulos y descripciones se acotan a los límites de Discord", () => {
  const p = buildWebhookPayload({ severity: "info", title: "t".repeat(1000), description: "d".repeat(10_000) });
  assert(p.embeds[0].title.length <= 256);
  assert(p.embeds[0].description.length <= 4096);
});

Deno.test("isMissingClaimRpc: solo «falta la migración 0076», no un fallo transitorio", () => {
  assertEquals(isMissingClaimRpc({ code: "PGRST202", message: "Could not find the function public.claim_alerts_for_webhook(p_kinds, p_limit) in the schema cache" }), true);
  assertEquals(isMissingClaimRpc({ message: "Could not find the function public.claim_alerts_for_webhook in the schema cache" }), true);
  assertEquals(isMissingClaimRpc({ code: "57014", message: "canceling statement due to statement timeout" }), false);
  assertEquals(isMissingClaimRpc(null), false);
});
