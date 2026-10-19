// _shared/alert-kinds.ts
// REGISTRO ÚNICO de los tipos de alerta del sistema y de si salen por webhook (Slack/Discord).
//
// Cada alerta se inserta en `alerts` (o, las de salud, en `system_incidents`) por quien
// la detecta: alerts-scan, health-scan, kommo-webhook, publish-to-kommo, follow-up-scan,
// dreams-run, funciones SQL… Notificar por webhook es una decisión POR TIPO (alert_config.
// webhook_kinds): acá se documenta cuáles van y cuáles no, con su motivo. Lo verifica
// alert-kinds.test.ts contra la migración 0076 (el default de webhook_kinds) y contra los
// tipos que de verdad se insertan en el código y en el SQL, para que un tipo nuevo no
// pueda quedar fuera del registro sin que falle un test.
//
// Inserción: TODO insert a `alerts` desde las Edge Functions pasa por `insertAlert`
// (_shared/alerts.ts), cuyo `kind` es `AlertKind` (unión derivada de este registro): un tipo
// no registrado no compila (`npm run check`) y el test rechaza cualquier insert directo.
//
// Entrega: alerts-scan (cada 5 min) barre las alertas sin notificar (alerts.webhook_notified_at
// is null; RPC claim_alerts_for_webhook, 0076) y postea las de tipos notificables, sin importar
// quién las insertó — también las que crea el propio alerts-scan (un único camino de envío).

export type AlertKindInfo = {
  /** ¿Sale por Slack/Discord? (default de alert_config.webhook_kinds) */
  webhook: boolean;
  /** Dónde vive: `alerts` o `system_incidents` (health-scan, que postea por su cuenta). */
  table: "alerts" | "system_incidents";
  /** Por qué va (o no va) al webhook. */
  reason: string;
  /**
   * Severidad del tipo. Los `critical` tienen PRIORIDAD en el barrido del webhook: salen primero
   * y nunca esperan detrás de warnings o infos aunque alguien inunde esos (claim_alerts_for_webhook).
   */
  severity: "critical" | "warning" | "info";
  /**
   * Tipos de alta frecuencia y origen EXTERNO (los puede disparar un tercero sin autenticar): se
   * agregan en UNA fila por ventana (contador + último detalle) en el INSERT mismo
   * (insert_alert_aggregated, 0076), para que ni la tabla ni el webhook crezcan con una inundación.
   */
  aggregateMinutes?: number;
  /**
   * UNA alerta por entidad (`ref_id`), para siempre: la base rechaza la copia con 23505
   * (índice único parcial de la migración 0091, cuya lista de tipos alert-kinds.test.ts
   * verifica contra este registro). Sin esto, un chequeo previo que falla o llega cortado
   * vuelve a crear la alerta en cada barrido.
   */
  onePerRef?: true;
};

export const ALERT_KINDS = {
  draft_failed: { webhook: true, table: "alerts", severity: "warning", reason: "una respuesta del agente falló y el cliente puede quedar sin contestación", onePerRef: true },
  human_review_needed: { webhook: true, table: "alerts", severity: "warning", reason: "un mensaje requiere que una persona lo atienda (toxicidad, queja seria)", onePerRef: true },
  outcomes_regression: { webhook: true, table: "alerts", severity: "warning", reason: "la calidad de las respuestas bajó de forma sostenida" },
  inbound_silence: { webhook: true, table: "alerts", severity: "critical", reason: "no entra ningún mensaje en horario laboral: síntoma de webhook deshabilitado" },
  inbound_dropped: { webhook: true, table: "alerts", severity: "critical", reason: "se perdió un payload de Kommo (Kommo no lo reintenta): mensaje de un cliente sin entrar", aggregateMinutes: 15 },
  kommo_webhook_disabled: { webhook: true, table: "alerts", severity: "critical", reason: "Kommo deshabilitó el webhook: el agente está mudo" },
  budget_exceeded: { webhook: true, table: "alerts", severity: "critical", reason: "el techo de gasto mensual frenó al agente" },
  outbound_blocked: { webhook: true, table: "alerts", severity: "warning", reason: "un texto con residuo interno se frenó antes de llegar al cliente: hay que revisarlo a mano" },
  salesbot_not_delivered: { webhook: true, table: "alerts", severity: "critical", reason: "no se pudo confirmar que un mensaje salió al cliente (y no se reenvía a ciegas): revisión humana" },
  provider_credit_exhausted: { webhook: true, table: "alerts", severity: "critical", reason: "se acabó el crédito del proveedor de IA: el agente deja de responder hasta recargar" },
  webhook_unsigned: { webhook: true, table: "alerts", severity: "warning", reason: "el webhook de Kommo llega sin secreto durante la transición: acción del operador (agregada: una fila por 6 h con contador)", aggregateMinutes: 360 },
  webhook_rejected: { webhook: true, table: "alerts", severity: "warning", reason: "se descartaron requests al webhook con secreto inválido (posible intento de falsificación; agregada: una fila por hora con contador)", aggregateMinutes: 60 },
  kommo_webhook_caido: { webhook: true, table: "system_incidents", severity: "critical", reason: "incidente de salud: el webhook de Kommo no responde" },
  kommo_token: { webhook: true, table: "system_incidents", severity: "critical", reason: "incidente de salud: el token de Kommo venció o fue revocado" },
  ingesta_detenida: { webhook: true, table: "system_incidents", severity: "critical", reason: "incidente de salud: dejó de entrar tráfico" },
  cola_atascada: { webhook: true, table: "system_incidents", severity: "critical", reason: "incidente de salud: la cola de entrada está atascada" },
  registro_abierto: {
    webhook: true,
    table: "system_incidents",
    severity: "critical",
    reason: "incidente de seguridad: el registro público de Supabase Auth está abierto (cualquiera con la anon key podría darse de alta)",
  },
  // Tipos propios de SuperCines (no existen en el template).
  media_processing_failed: {
    webhook: false,
    table: "alerts",
    severity: "info",
    reason: "un adjunto (imagen, audio, documento) de un lead no se pudo leer: es por mensaje y puede repetirse muchas veces al día, así que queda en el panel de alertas y no en Slack",
  },
  dream_error: {
    webhook: false,
    table: "alerts",
    severity: "info",
    reason: "es feedback de calidad del agente, no una caída: puede dispararse varias veces por corrida y se revisa en /dreams (donde se aprueba o descarta)",
  },
} as const satisfies Record<string, AlertKindInfo>;

/** Todo tipo registrado (alertas e incidentes de salud). */
export type RegisteredKind = keyof typeof ALERT_KINDS;

/** Tipos que viven en la tabla `alerts`: lo ÚNICO que acepta `insertAlert`. */
export type AlertKind = {
  [K in RegisteredKind]: (typeof ALERT_KINDS)[K]["table"] extends "alerts" ? K : never;
}[RegisteredKind];

/** Tipos `critical` (los que el barrido del webhook atiende primero). */
export function criticalKinds(): string[] {
  return Object.entries(ALERT_KINDS).filter(([, v]) => v.severity === "critical").map(([k]) => k);
}

/** Ventana de agregación (minutos) de un tipo de alta frecuencia y origen externo; undefined = no se agrega. */
export function aggregateWindowMinutes(kind: string): number | undefined {
  const info = (ALERT_KINDS as Record<string, AlertKindInfo>)[kind];
  return info?.aggregateMinutes;
}

/** Tipos de UNA alerta por entidad (índice único de 0091), en el orden del registro. */
export function onePerRefKinds(): string[] {
  return Object.entries(ALERT_KINDS as Record<string, AlertKindInfo>).filter(([, v]) => v.onePerRef).map(([k]) => k);
}

/** Tipos que salen por webhook, en el orden del registro. */
export function webhookKindsDefault(): string[] {
  return Object.entries(ALERT_KINDS).filter(([, v]) => v.webhook).map(([k]) => k);
}

export type WebhookConfigLike = { webhook_enabled: boolean; webhook_url: string | null; webhook_kinds: string[] };

/** ¿Hay que barrer? Sin webhook activo no se reclama nada (las alertas esperan a que se configure). */
export function shouldSweep(cfg: WebhookConfigLike | null): cfg is WebhookConfigLike & { webhook_url: string } {
  return Boolean(cfg && cfg.webhook_enabled && cfg.webhook_url);
}
