// _shared/response-guard.ts
//
// Verificador final de respuestas — GATE CRÍTICO.
//
// Detecta respuestas que en realidad son mensajes INTERNOS del sistema
// (residuo de sintaxis de tool-calling, razonamiento del agente, rutas de
// Memory Store, errores técnicos) que NUNCA deben llegar al cliente por
// WhatsApp/Instagram.
//
// Es determinístico (regex) y de costo cero. Se usa en dos puntos del
// pipeline:
//   1) generate-response: si el bloque <respuesta> viene malformado o el
//      texto extraído matchea un patrón de fuga, el draft NUNCA se
//      auto-aprueba (queda en revisión humana con guard_blocked=true),
//      sin importar bypass_review ni el modo de la vertical.
//   2) publish-to-kommo: backstop final antes de enviar — cubre drafts
//      aprobados a mano desde el dashboard o generados antes de que
//      existiera este guard. Si matchea, NO se envía.
//
// Origen: incidente real en producción de otro agente del gremio (nacido de
// este mismo template). El modelo cerró el turno con
// `<parameter name="respuesta">` en vez de `<respuesta>` — la extracción no
// matcheó y el código de entonces caía a un fallback que usaba el texto
// CRUDO del modelo, así que al cliente le llegó el razonamiento interno
// completo (tool calls, nombres de tools, meta-narración) con el tag pegado
// en el medio. La lección: la extracción del bloque de respuesta NUNCA puede
// tener un fallback al texto crudo (ver `extractResponseBlock` abajo), y el
// texto que SÍ se extrae hay que revisarlo por si trae residuo de ese mismo
// razonamiento aunque el tag haya cerrado bien.

/**
 * Patrones de precisión alta: ninguno de estos aparece en una respuesta real
 * de atención al cliente de un negocio cualquiera, así que el riesgo de falso
 * positivo es bajo. Los nombres de tool y las rutas de Memory Store son los
 * genéricos que declara ESTE template (`generate-response/index.ts`); un
 * cliente del gremio que agregue tools propias por HTTP (`agent_tools`) no
 * queda cubierto por nombre aquí — pero cualquier fuga de esas queda igual
 * atrapada por los patrones de sintaxis de tool-calling (`<invoke>`,
 * `<function_calls>`, `tool_use`, etc.), que no dependen del nombre.
 */
const INTERNAL_LEAK_PATTERNS: { re: RegExp; label: string }[] = [
  // ── Residuo de sintaxis: tags del protocolo o de tool-calling ──
  { re: /<\s*\/?\s*respuesta\s*>/i, label: "tag <respuesta> sin parsear" },
  { re: /<\s*parameter\b|<\s*\/\s*parameter\s*>/i, label: "tag <parameter> (tool-call)" },
  { re: /<\s*\/?\s*(?:invoke|function_calls|function_results|antml:[a-z]+|thinking|result|tool_use|tool_result)\b/i, label: "sintaxis de tool-call" },
  // ── Nombres de tools internas del template (el prompt prohíbe revelarlas) ──
  { re: /\b(?:search_kb|mover_etapa|actualizar_lead|actualizar_contacto|buscar_producto|ver_categorias|consultar_pedido|crear_link_pago|tasa_bcv|consultar_cartelera)\b/i, label: "nombre de tool interna" },
  // ── Rutas y archivos de Memory Store (arquitectura master/leads del template) ──
  { re: /\/mnt\/memory\b|\b(?:conversation|learnings)\.md\b|\/dreams\/|\/voice\/|\/kb\//i, label: "ruta interna de memoria" },
  // ── Mecánica interna de Kommo (nunca se le nombra al cliente) ──
  { re: /\bsalesbot\b/i, label: "mecánica interna de Kommo (salesbot)" },
  // ── Meta-narración de planificación (el agente hablando de su propio turno) ──
  // Anclados a inicio de línea o con sujeto explícito para no pisar frases
  // legítimas como "voy a mostrarte las opciones" (esa NO matchea).
  { re: /^\s*(?:ahora\s+)?(?:redacto|voy a redactar|procedo a redactar)\b/im, label: "meta-narración (redacción)" },
  { re: /^\s*el\s+lead\s*:/im, label: "meta-narración (habla del lead en tercera persona)" },
  { re: /\b(?:mi|el)\s+(?:borrador|draft)\s+(?:anterior|previo)\b/i, label: "meta-narración (borrador)" },
  { re: /\[?\s*VERIFICADOR\s+INTERNO\s*[—\-]?/i, label: "eco del mensaje del verificador" },
  { re: /\bFUSE\b/i, label: "FUSE" },
  { re: /memoria\s+(remota|persistente|del\s+agente)/i, label: "memoria remota/persistente" },
  { re: /sistema\s+de\s+memoria/i, label: "sistema de memoria" },
  { re: /\bmemory\s*store\b/i, label: "memory store" },
  { re: /persistent\s+memory|remote\s+memory/i, label: "persistent/remote memory" },
  { re: /file\s?system|filesystem/i, label: "filesystem" },
  { re: /disk\s+quota|quota\s+exceeded|cuota\s+(de|en)\s+memoria/i, label: "quota" },
  // Variante vista en producción: "(Los archivos de memoria están llenos — el
  // sistema tiene límites de cuota...)". No matcheaba ningún patrón de arriba:
  // los de memoria pedían "remota/persistente/del agente" y el de quota pedía
  // "cuota DE memoria" — de ahí estos dos adicionales, más laxos a propósito.
  // OJO con `cuota` a secas: "pagar en cuotas" es lenguaje comercial normal en
  // más de un rubro, así que se exige el contexto "límite(s) de cuota".
  { re: /archivos?\s+de\s+memoria/i, label: "archivos de memoria" },
  { re: /memoria\s+(?:est[áa]n?\s+)?(?:llen|complet|agotad)/i, label: "memoria llena" },
  { re: /l[ií]mites?\s+de\s+cuota/i, label: "límites de cuota" },
  { re: /\bI\/O\b|input\/output/i, label: "I/O" },
  { re: /flujo\s+obligatorio/i, label: "flujo obligatorio" },
  { re: /la\s+respuesta\s+ya\s+ha\s+sido\s+redactada/i, label: "meta-narración" },
  { re: /(no\s+pud[eo]|no\s+puedo|falla|error|problema).{0,40}(actualizar|guardar|escribir|persistir).{0,20}(la\s+)?memoria/i, label: "error de memoria" },
  { re: /\bsystem\s+prompt\b|\btool[_\s]?use\b|herramienta\s+interna/i, label: "referencia interna" },
  { re: /continuar[ée]?\s+sin\s+actualizar/i, label: "narración de fallo interno" },
];

/**
 * Devuelve el motivo (etiqueta del patrón) si el texto parece un mensaje
 * interno que NO debe llegar al cliente, o null si la respuesta es apta para
 * enviar.
 */
export function detectInternalLeak(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const { re, label } of INTERNAL_LEAK_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

/**
 * Extrae SOLO lo que va dentro de <respuesta>...</respuesta>.
 *
 * Antes esto vivía inline en generate-response con un fallback fatal: si el
 * tag no matcheaba, usaba el texto CRUDO — que es exactamente cómo el
 * razonamiento del agente terminó en el chat de un cliente. Aquí el fallback
 * NO existe: si no hay un bloque bien formado, `wellFormed` es false y el
 * llamador está obligado a NO auto-enviar (forzar revisión humana), no a
 * reprocesar en silencio y confiar en el texto rescatado.
 *
 * `salvaged` intenta rescatar el cuerpo de las malformaciones conocidas para
 * que un humano tenga algo que editar en el draft — NUNCA para enviarlo sin
 * verificar.
 */
export function extractResponseBlock(raw: string | null | undefined): {
  text: string;
  wellFormed: boolean;
} {
  const s = (raw ?? "").trim();
  if (!s) return { text: "", wellFormed: false };

  const ok = s.match(/<respuesta>([\s\S]*?)<\/respuesta>/i);
  if (ok) return { text: ok[1].trim(), wellFormed: true };

  // Malformación observada en producción: el modelo envuelve la respuesta en
  // el shape de un parámetro de tool-call en vez del tag del protocolo.
  const asParam = s.match(/<\s*parameter\s+name\s*=\s*"respuesta"\s*>([\s\S]*?)(?:<\s*\/\s*parameter\s*>|$)/i);
  if (asParam) return { text: asParam[1].trim(), wellFormed: false };

  // Apertura sin cierre: tomamos lo que sigue al tag.
  const openOnly = s.match(/<respuesta>([\s\S]*)$/i);
  if (openOnly) return { text: openOnly[1].trim(), wellFormed: false };

  // Sin ninguna marca: NO devolvemos el crudo como si fuera la respuesta.
  return { text: s, wellFormed: false };
}

/**
 * Mensaje correctivo que se inyecta en la sesión CMA cuando la salida trae
 * contenido interno o el bloque <respuesta> vino malformado, para que el
 * agente reescriba en la MISMA sesión (barato: reusa el contexto y la
 * memoria ya montada) en vez de escalar directo a revisión humana.
 *
 * En español neutro a propósito: este texto entra al contexto del modelo, y
 * si el operador define una voz/dialecto particular en su system prompt, no
 * queremos que este mensaje del sistema se la contamine.
 */
export function leakCorrectionMessage(reason: string, opts: { allowNoReply?: boolean } = {}): string {
  return [
    "[VERIFICADOR INTERNO — NO es un mensaje del cliente, es una corrección del sistema]",
    `Tu salida anterior no se puede enviar: ${reason}.`,
    "El cliente NUNCA debe ver tu razonamiento, tus planes de redacción, nombres de herramientas, rutas de archivos internas ni etiquetas del protocolo.",
    "Reescribe la respuesta completa. Tu salida debe terminar con el bloque EXACTO:",
    "<respuesta>",
    "SOLO el texto que se le envía al cliente, listo para mandar tal cual",
    "</respuesta>",
    "Sin ningún texto después del bloque. Nada de lo que escribas antes del bloque llega al cliente, así que dentro del bloque no puede quedar ni una palabra sobre tu proceso interno.",
    // Sin un bloque bien formado puede que el agente haya DECIDIDO no responder (p. ej.
    // «solo emojis → no respondas» del operador) y lo haya escrito como análisis: se le
    // ofrece la salida explícita en vez de forzarlo a inventar un mensaje.
    ...(opts.allowNoReply
      ? ["Si decidiste NO responder a propósito (según tu system prompt o los aprendizajes del operador), en lugar del bloque anterior termina con: <sin_respuesta>motivo breve</sin_respuesta>"]
      : []),
  ].join("\n");
}
