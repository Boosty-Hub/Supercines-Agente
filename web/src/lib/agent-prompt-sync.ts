// Sincronización SEGURA del system prompt del agente (puro, sin I/O).
//
// PROBLEMA: syncAgentTools empuja runtime_config.SYSTEM_PROMPT + scaffold al Managed
// Agent y SOBRESCRIBE lo que haya allá. Si alguien editó el prompt vivo por fuera del
// dashboard (consola de Anthropic, otra herramienta), el botón «Sincronizar», el
// guardado de /agent y cualquier toggle que dispare un sync lo PISABAN sin avisar.
//
// DISEÑO: al empujar, se guarda en runtime_config.AGENT_PROMPT_SYNCED_HASH el hash del
// system EXACTO que se envió, junto con ANTHROPIC_AGENT_VERSION. Antes del siguiente
// empuje se lee el agente vivo y se compara:
//   · el hash del system vivo no coincide con el último sincronizado → CONFLICTO;
//   · la versión viva es MAYOR que la registrada (alguien subió una versión por
//     fuera, aunque el texto coincida) → CONFLICTO;
//   · primera vez (sin hash registrado): conflicto si lo vivo difiere de lo que se
//     enviaría. Un agente que ya coincide se adopta sin preguntar.
// En conflicto NO se sincroniza: se devuelve el diff y el usuario elige explícitamente
// importar el vivo a la DB o sobrescribir con el de la DB.
import { createHash } from "node:crypto";

/** El system se compara sin diferencias de fin de línea ni espacios en los extremos. */
function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

export function hashPrompt(system: string): string {
  return createHash("sha256").update(normalize(system)).digest("hex");
}

/** Encabezado con que empieza el CORE_SCAFFOLD (lib/agent-prompt.ts): separa prompt del operador y scaffold. */
const SCAFFOLD_MARKER = "\n\n---\n\n## Flujo obligatorio antes de redactar";

/**
 * La parte del prompt del OPERADOR dentro de un system compuesto (composeSystem pone
 * el prompt del operador primero y el scaffold fijo después). null si no se encuentra
 * el scaffold (alguien lo editó): no se puede separar con seguridad.
 */
export function extractOperatorPrompt(system: string): string | null {
  const s = normalize(system);
  const i = s.indexOf(SCAFFOLD_MARKER);
  return i < 0 ? null : s.slice(0, i).trim();
}

export type DiffLine = { type: "same" | "add" | "del"; text: string };

/** Diff por líneas (LCS). `del` = solo en `live`, `add` = solo en `db`. */
export function lineDiff(live: string, db: string): DiffLine[] {
  const a = normalize(live).split("\n");
  const b = normalize(db).split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: a[i++] });
    } else {
      out.push({ type: "add", text: b[j++] });
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

export type PromptConflictKind =
  /** El system vivo ya no es el que se envió la última vez. */
  | "prompt_changed"
  /** Alguien subió una versión del agente por fuera (el texto puede coincidir). */
  | "version_ahead"
  /** Primera sincronización (sin hash registrado) y lo vivo difiere de lo que se enviaría. */
  | "first_sync_differs";

export type PromptConflict = {
  kind: PromptConflictKind;
  live: { version: number | null; operatorPrompt: string | null };
  db: { version: number | null; operatorPrompt: string | null };
  /** Prompt vivo (izquierda, `del`) contra el que se enviaría desde la DB (derecha, `add`). */
  diff: DiffLine[];
};

export function detectPromptConflict(input: {
  /** system del agente vivo (retrieveAgent). */
  liveSystem: string | null | undefined;
  liveVersion: number | null;
  /** runtime_config.AGENT_PROMPT_SYNCED_HASH. */
  syncedHash: string | null | undefined;
  /** runtime_config.ANTHROPIC_AGENT_VERSION. */
  registeredVersion: number | null;
  /** El system que se enviaría ahora (composeSystem con el prompt de la DB). */
  composedSystem: string;
}): PromptConflict | null {
  const { liveSystem, liveVersion, syncedHash, registeredVersion, composedSystem } = input;
  // Sin system vivo no hay nada que sobrescribir.
  if (!liveSystem || !normalize(liveSystem)) return null;

  const liveHash = hashPrompt(liveSystem);
  let kind: PromptConflictKind | null = null;
  if (syncedHash) {
    if (liveHash !== syncedHash) kind = "prompt_changed";
    else if (liveVersion != null && registeredVersion != null && liveVersion > registeredVersion) kind = "version_ahead";
  } else if (liveHash !== hashPrompt(composedSystem)) {
    kind = "first_sync_differs";
  }
  if (!kind) return null;

  const liveOp = extractOperatorPrompt(liveSystem);
  const dbOp = extractOperatorPrompt(composedSystem);
  return {
    kind,
    live: { version: liveVersion, operatorPrompt: liveOp },
    db: { version: registeredVersion, operatorPrompt: dbOp },
    // Si se pudo separar el prompt del operador se compara solo eso (lo que el
    // operador edita); si no, el system completo.
    diff: lineDiff(liveOp ?? liveSystem, dbOp ?? composedSystem),
  };
}

/** Texto para el usuario (español) según el tipo de conflicto. */
export function conflictMessage(c: PromptConflict): string {
  switch (c.kind) {
    case "version_ahead":
      return "El agente en Anthropic tiene una versión más nueva que la última sincronizada desde el dashboard: alguien lo modificó por fuera.";
    case "first_sync_differs":
      return "El prompt del agente en Anthropic es distinto del que enviaría el dashboard y no hay una sincronización previa registrada para saber cuál es el correcto.";
    default:
      return "El prompt del agente fue modificado fuera del dashboard (consola de Anthropic u otra herramienta).";
  }
}
