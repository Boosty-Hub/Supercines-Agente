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
//   · primera vez (sin hash registrado: clientes que actualizan): se compara SOLO el
//     prompt del OPERADOR vivo contra el de la DB (con placeholders sustituidos). El
//     scaffold/tools son del código: si el operador coincide, se adopta sin preguntar
//     (el push siguiente actualiza el scaffold y registra el hash).
// En conflicto NO se sincroniza: se devuelve el diff y el usuario elige explícitamente
// importar el vivo a la DB o sobrescribir con el de la DB.
import { createHash } from "node:crypto";
import type { PlaceholderValues } from "./agent-prompt.ts";
import { placeholderize, type PlaceholderizeResult } from "./prompt-placeholders.ts";

/** El system se compara sin diferencias de fin de línea ni espacios en los extremos. */
function normalize(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

export function hashPrompt(system: string): string {
  return createHash("sha256").update(normalize(system)).digest("hex");
}

/** Encabezado con que empieza el CORE_SCAFFOLD (lib/agent-prompt.ts): separa prompt del operador y scaffold. */
const SCAFFOLD_START = "---\n\n## Flujo obligatorio antes de redactar";
const SCAFFOLD_MARKER = `\n\n${SCAFFOLD_START}`;

/**
 * Dónde empieza el scaffold en un system normalizado, o -1. Con SYSTEM_PROMPT vacío (o solo
 * espacios) el system compuesto ES el scaffold: tras normalizar, el marcador queda AL INICIO
 * sin los `\n\n` previos, y buscar solo `\n\n---` lo daba por perdido (el prompt vacío del
 * operador se tomaba por «scaffold editado» y no se podía separar ni importar).
 */
function scaffoldIndex(s: string): number {
  if (s.startsWith(SCAFFOLD_START)) return 0;
  return s.indexOf(SCAFFOLD_MARKER);
}

/**
 * La parte del prompt del OPERADOR dentro de un system compuesto (composeSystem pone
 * el prompt del operador primero y el scaffold fijo después). "" si el operador no
 * escribió nada. null si no se encuentra el scaffold (alguien lo editó): no se puede
 * separar con seguridad.
 */
export function extractOperatorPrompt(system: string): string | null {
  const s = normalize(system);
  const i = scaffoldIndex(s);
  return i < 0 ? null : s.slice(0, i).trim();
}

/**
 * La parte del scaffold (desde el `---` que lo separa del operador) de un system
 * compuesto. null si no se encuentra el marcador.
 */
export function extractScaffold(system: string): string | null {
  const s = normalize(system);
  const i = scaffoldIndex(s);
  return i < 0 ? null : s.slice(i).trim();
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
  /** Primera sincronización (sin hash registrado) y el prompt de OPERADOR vivo difiere del de la DB. */
  | "first_sync_differs";

/**
 * QUÉ difiere exactamente (para que la UI no mezcle el prompt del operador con el scaffold):
 *  · operator: solo el prompt del operador;
 *  · scaffold: el prompt del operador es IDÉNTICO y lo que cambió es el scaffold/instrucciones
 *    del sistema (incluye el bloque de acciones CRM, derivado de las tools);
 *  · both: ambos;
 *  · none: el texto es idéntico (solo cambió la versión);
 *  · unknown: el system vivo no conserva el scaffold esperado → no se puede separar; el diff es del system completo.
 */
export type ConflictScope = "operator" | "scaffold" | "both" | "none" | "unknown";

export type PromptConflict = {
  kind: PromptConflictKind;
  scope: ConflictScope;
  /**
   * Hash del system VIVO que se le mostró al operador. La resolución lo devuelve
   * (`expectedLiveHash`) y el servidor ABORTA si el vivo cambió entre mostrar y resolver
   * (TOCTOU): si no, «importar» o «sobrescribir» actuaría sobre un texto que el operador nunca vio.
   */
  liveHash: string;
  /** Texto para el usuario que dice EXACTAMENTE qué difiere (lo arma conflictMessage). */
  message: string;
  live: { version: number | null; operatorPrompt: string | null };
  db: { version: number | null; operatorPrompt: string | null };
  /**
   * Diff del prompt del OPERADOR (izquierda `del` = vivo, derecha `add` = el de la DB) o,
   * si scope = unknown, del system completo.
   */
  diff: DiffLine[];
  /** Diff del scaffold (vivo vs el que se enviaría); null si es igual o no se pudo separar. */
  scaffoldDiff: DiffLine[] | null;
  /**
   * Qué quedaría en SYSTEM_PROMPT al «importar el vivo» (con los placeholders conocidos
   * restituidos) y qué valores quedaron ambiguos y NO se tocaron. null si no se puede importar.
   */
  importPreview: (PlaceholderizeResult & { changed: boolean }) | null;
};

export type ResolveGuard = { ok: true } | { ok: false; reason: "missing_hash" | "stale" };

/**
 * Guardia anti-TOCTOU de la resolución explícita de un conflicto. `expected` es el hash del
 * system vivo que se mostró al operador; `liveSystem`, el vivo AHORA. Sin hash no se resuelve
 * (la UI siempre lo manda) y si el vivo cambió se aborta: hay que volver a mostrarle el diff.
 */
export function checkResolveHash(expected: string | null | undefined, liveSystem: string | null | undefined): ResolveGuard {
  if (!expected) return { ok: false, reason: "missing_hash" };
  return hashPrompt(liveSystem ?? "") === expected ? { ok: true } : { ok: false, reason: "stale" };
}

const sameText = (a: string, b: string) => normalize(a) === normalize(b);

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
  /** Valores de los placeholders (para re-placeholderizar al importar). Sin ellos no se restituye nada. */
  placeholderValues?: PlaceholderValues;
  /** Texto con que se sustituye {{TOOLS_LIST}} (para restituirlo al importar). */
  toolsList?: string;
}): PromptConflict | null {
  const { liveSystem, liveVersion, syncedHash, registeredVersion, composedSystem, placeholderValues, toolsList } = input;
  // Sin system vivo no hay nada que sobrescribir.
  if (!liveSystem || !normalize(liveSystem)) return null;

  const liveOp = extractOperatorPrompt(liveSystem);
  const dbOp = extractOperatorPrompt(composedSystem);
  const liveScaffold = extractScaffold(liveSystem);
  const dbScaffold = extractScaffold(composedSystem);
  const separable = liveOp !== null && dbOp !== null && liveScaffold !== null && dbScaffold !== null;
  const operatorDiffers = separable && !sameText(liveOp, dbOp);
  const scaffoldDiffers = separable && !sameText(liveScaffold, dbScaffold);

  let kind: PromptConflictKind | null = null;
  if (syncedHash) {
    const liveHash = hashPrompt(liveSystem);
    // Si lo vivo ya ES lo que se enviaría (p. ej. un push anterior cuyo registro de hash no
    // llegó a guardarse) sobrescribir no pierde nada: no hay nada que decidir.
    if (liveHash !== syncedHash) {
      if (liveHash === hashPrompt(composedSystem)) return null;
      kind = "prompt_changed";
    } else if (liveVersion != null && registeredVersion != null && liveVersion > registeredVersion) kind = "version_ahead";
  } else if (separable) {
    // Primera vez: solo el prompt del operador decide. El scaffold lo gobierna el código.
    if (operatorDiffers) kind = "first_sync_differs";
  } else if (hashPrompt(liveSystem) !== hashPrompt(composedSystem)) {
    kind = "first_sync_differs";
  }
  if (!kind) return null;

  const scope: ConflictScope = !separable
    ? "unknown"
    : operatorDiffers && scaffoldDiffers
      ? "both"
      : operatorDiffers
        ? "operator"
        : scaffoldDiffers
          ? "scaffold"
          : "none";

  const scaffoldDiff = separable && scaffoldDiffers ? lineDiff(liveScaffold, dbScaffold) : null;
  let importPreview: PromptConflict["importPreview"] = null;
  if (liveOp !== null) {
    const p = placeholderValues ? placeholderize(liveOp, placeholderValues, { toolsList }) : { text: liveOp, replaced: [], ambiguous: [] };
    importPreview = { ...p, changed: p.replaced.length > 0 };
  }
  const conflict: PromptConflict = {
    kind,
    scope,
    message: "",
    liveHash: hashPrompt(liveSystem),
    live: { version: liveVersion, operatorPrompt: liveOp },
    db: { version: registeredVersion, operatorPrompt: dbOp },
    diff: separable ? lineDiff(liveOp, dbOp) : lineDiff(liveSystem, composedSystem),
    scaffoldDiff,
    importPreview,
  };
  conflict.message = conflictMessage(conflict);
  return conflict;
}

/** Texto para el usuario (español): dice EXACTAMENTE qué difiere. */
export function conflictMessage(c: PromptConflict): string {
  const que: Record<ConflictScope, string> = {
    operator: "Difiere el prompt del operador.",
    scaffold: "El prompt del operador es idéntico; lo que difiere son las instrucciones del sistema (scaffold / acciones de herramientas) del agente vivo.",
    both: "Difieren el prompt del operador y las instrucciones del sistema (scaffold / acciones de herramientas).",
    none: "El texto del prompt es el mismo.",
    unknown: "El system del agente vivo no conserva la estructura esperada (prompt del operador + instrucciones del sistema): se muestra el system completo.",
  };
  switch (c.kind) {
    case "version_ahead":
      return `El agente en Anthropic tiene una versión más nueva que la última sincronizada desde el dashboard: alguien lo modificó por fuera. ${que[c.scope]}`;
    case "first_sync_differs":
      return `No hay una sincronización previa registrada y el prompt del OPERADOR en Anthropic es distinto del de la plataforma. ${que[c.scope]}`;
    default:
      return `El agente fue modificado fuera del dashboard (consola de Anthropic u otra herramienta). ${que[c.scope]}`;
  }
}
