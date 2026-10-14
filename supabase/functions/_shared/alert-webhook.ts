// _shared/alert-webhook.ts
// Cuerpo del aviso que alerts-scan postea al webhook de alertas (Slack y Discord con el
// MISMO payload: Slack lee `text`, Discord lee `embeds`).
//
// El título y la descripción traen texto de terceros (p. ej. el display_name del lead, que
// lo elige quien escribe por Instagram/WhatsApp). Sin neutralizar, un nombre como
// "<!channel>" o "@everyone" notificaría a todo el canal del operador, y
// "<https://evil|Kommo>" o "[Kommo](https://evil)" pintaría un link falso. Por eso:
//  · Slack: se escapan &, < y > (las tres entidades que exige Slack): no hay menciones
//    (<!channel>, <@U…>) ni links <url|texto> que no escribamos nosotros.
//  · Discord: no interpreta entidades HTML, así que NO se escapa igual; se cortan las
//    menciones (@everyone/@here, <@…>, <#…>) y los links enmascarados [texto](url) con un
//    espacio de ancho cero, y además `allowed_mentions: { parse: [] }` (Discord no
//    notifica a nadie aunque algo se escape del filtro).

import { truncateGraphemes } from "./text-safe.ts";

export type WebhookAlert = {
  severity: string;
  title: string;
  description: string | null;
  /** Idénticas suprimidas por el dedupe en el mismo barrido (claim_alerts_for_webhook). */
  repeated?: number;
};

const ZWSP = "​";
const TITLE_MAX = 200; // Discord: título de embed ≤ 256
const DESCRIPTION_MAX = 3500; // Discord: descripción de embed ≤ 4096

/** Slack: escapa las tres entidades de control (&, <, >). */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Discord: corta menciones masivas/directas y links enmascarados. */
export function neutralizeDiscord(text: string): string {
  return text
    .replace(/@(everyone|here)/gi, `@${ZWSP}$1`)
    .replace(/<([@#])/g, `<${ZWSP}$1`)
    .replace(/\]\(/g, `]${ZWSP}(`);
}

/** «(+N repetidas)» cuando el barrido suprimió idénticas a la que sale. */
export function repeatedSuffix(repeated: number | undefined): string {
  const n = Math.max(0, Math.trunc(Number(repeated) || 0));
  if (n === 0) return "";
  return ` (+${n} ${n === 1 ? "repetida" : "repetidas"})`;
}

export function buildWebhookPayload(alert: WebhookAlert) {
  const emoji = alert.severity === "critical" ? "🚨" : alert.severity === "warning" ? "⚠️" : "ℹ️";
  const title = truncateGraphemes(alert.title, TITLE_MAX) + repeatedSuffix(alert.repeated);
  const description = truncateGraphemes(alert.description ?? "", DESCRIPTION_MAX);
  return {
    text: `${emoji} *${escapeSlack(title)}*\n${escapeSlack(description)}`,
    embeds: [
      {
        title: `${emoji} ${neutralizeDiscord(title)}`,
        description: neutralizeDiscord(description),
        color: alert.severity === "critical" ? 15158332 : alert.severity === "warning" ? 16294198 : 5814783,
      },
    ],
    allowed_mentions: { parse: [] as string[] },
  };
}

/**
 * ¿El RPC claim_alerts_for_webhook no existe? (PostgREST PGRST202: la migración 0076 todavía
 * no se aplicó). Distingue «falta la migración» de un fallo transitorio, que solo se loguea.
 */
export function isMissingClaimRpc(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "PGRST202") return true;
  return /could not find the function[^\n]*claim_alerts_for_webhook/i.test(error.message ?? "");
}
