# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

Template para construir un **agente conversacional sobre Kommo CRM** con clasificación, respuesta vía Anthropic Managed Agent (+ Memory Stores) — todo sobre **Haiku 5.5** (`claude-haiku-5-5`) por defecto, aprendizaje automático nocturno (Dreams) y evaluación de calidad (Outcomes). Se customiza para cualquier operador **desde el dashboard** (`/setup` + `/agent`), sin tocar código.

Repo: `web/` (Next.js 15 (React 19) dashboard + API routes) + `supabase/` (Postgres migrations + Edge Functions Deno) + `agent/` (template de system prompt).

## Desplegar un cliente nuevo (zero-CLI — todo desde el navegador)

El flujo es **single-tenant**: un clon = un cliente. Cada cliente tiene su propio Supabase, su propia conexión Kommo y su propia cuenta/API key de Anthropic. La personalización por cliente vive en la tabla `runtime_config` (DB), editable desde el dashboard — NO se edita código.

1. **Crear infra externa** (manual, irreducible): un proyecto Supabase nuevo, una API key de Anthropic, una integración long-lived token en Kommo.
2. **Deployar en Netlify/Vercel** (import from Git, una vez): en **Netlify es zero-config** — `netlify.toml` ya fija `base = "web"`, `command = "pnpm build"`, `publish = ".next"`, Node 20 y `@netlify/plugin-nextjs`. En Vercel: root directory = `web/`, build `pnpm build`. El host hace checkout del repo **completo** (no solo `web/`) para que el codegen lea `../supabase/` en el build. El **primer deploy FALLA** hasta cargar las env vars — es esperado.
3. **Configurar las 3 variables en el host** (Netlify: Site configuration → Environment variables · Vercel: Project Settings → Environment Variables), luego **redesplegar**. Las tres salen del proyecto Supabase nuevo en **Project Settings → API**. ⚠️ Usar las keys **LEGACY JWT** (empiezan con `eyJ`), NO las nuevas `sb_publishable_`/`sb_secret_` (PostgREST rechaza las nuevas):
   - `NEXT_PUBLIC_SUPABASE_URL` — Project URL (`https://<ref>.supabase.co`)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Legacy API keys → `anon (public)`
   - `SUPABASE_SERVICE_ROLE_KEY` — Legacy API keys → `service_role (secret)`
4. **Abrir la URL** → el wizard `/first-run` detecta el estado y guía el siguiente paso.
5. **Wizard `/first-run`**: paso Conectar (ya hecho) → paso Inicializar (pegás un Personal Access Token `sbp_...` de `supabase.com/dashboard/account/tokens`; el wizard aplica las migraciones + deploya las Edge Functions con progreso en vivo) → paso Crear usuario (email + contraseña; bloquea registros adicionales). Al terminar, entrás **directo al dashboard** (`/inbox`). **Acá el onboarding crea/provisiona todo el proyecto solo.**
6. **Wizard de provisioning (panel lateral, NO bloqueante)**: Anthropic credentials + Managed Agent + Verticales (opcional) + Memory Stores + Kommo. Vive como un drawer derecho SOBRE el dashboard (`web/src/app/(dashboard)/setup-drawer.tsx`), se auto-abre 1x por sesión si falta config, se puede cerrar/reabrir (botón flotante o `/setup`, que redirige a `/inbox?setup=open`). Idempotente. Estado computado en `web/src/lib/setup-state.ts` (DB-only).
7. **`/agent`**: editás voz/identidad/branding cuando quieras; al guardar sincroniza el system prompt con Anthropic (sube versión).

> **Guía paso-a-paso completa** (para humanos, con cada wizard detallado): `README.md` (Pasos 1-7) y `SETUP-WITH-CLAUDE.md` (Fase 4 deploy Netlify/Vercel · Fase 5 env vars + `/first-run`). Mantené estas tres en sync si cambia el flujo.

### Codegen automático

`pnpm dev` y `pnpm build` corren automáticamente `node scripts/embed-provision.mjs` (hooks `predev`/`prebuild`). El script embebe todas las migraciones SQL y el source de las 8 Edge Functions en archivos TypeScript generados (`web/src/lib/provision/*.generated.ts`, gitignoreados). Esto permite que el wizard `/first-run` aplique migraciones y despliegue funciones sin acceso al filesystem en runtime. **Si el directorio `../supabase/` no existe, el build falla intencionalmente** — diseñado para que el build no pase en silencio con un provisioner vacío.

### Precedencia de config (clave)

`runtime_config` es la **single source of truth**. Web y Edge Functions resuelven cada key **DB-first / env-fallback**: si la fila existe y `value` no es NULL ni `""` → se usa; si no → variable de entorno; si no → undefined. Los lectores: `web/src/lib/runtime-config.ts` (React `cache()` por request) y `supabase/functions/_shared/config.ts` (cache TTL 60s, lectura en runtime). Tras escribir config desde el dashboard, las Edge Functions la toman dentro de 60s sin redeploy.

```bash
# Front (desde web/)
cd web && pnpm install
pnpm dev            # dev server :3000; corre codegen automáticamente al arrancar
pnpm build
npx tsc --noEmit    # typecheck — correr SIEMPRE tras editar el front (no hay test suite)

# Re-deploy de una Edge Function puntual
SUPABASE_ACCESS_TOKEN=<token> npx supabase functions deploy <fn> --project-ref <ref>
```

> No hay `pnpm bootstrap`, `pnpm migrate` ni `pnpm user:master`. Esos scripts fueron eliminados. Todo sucede desde el browser vía `/first-run`. Para desarrollo local, el codegen corre automáticamente en `predev`.

No hay linter más allá de `eslint-config-next`. Verificación de cada cambio del front: `npx tsc --noEmit`.

Las Edge Functions **sí** se pueden typechequear y testear localmente aunque Deno no esté instalado:

```bash
npx deno@2 check --node-modules-dir=auto supabase/functions/*/index.ts supabase/functions/_shared/*.ts
npx deno@2 test  --allow-net --allow-read --allow-env --node-modules-dir=auto supabase/tests supabase/functions/_shared/
```

Hacelo SIEMPRE antes de deployar: el deploy no typechequea, así que un error de tipos llega a producción en silencio.

⚠️ `npx tsc --noEmit` NO sustituye a `pnpm build`. Next valida reglas propias que `tsc` no ve — por ejemplo, un `route.ts` **no puede exportar nada que no sea un handler** (`export function parseTerms` → `"parseTerms" is not a valid Route export field`, con `tsc` en verde). Los helpers compartidos entre rutas van en `src/lib/`, nunca exportados desde un `route.ts`.

Incluye `supabase/tests/web-parity.test.ts` (paridad web↔Edge de pricing, modelos y alcances) y `dashboard-ai-body.test.ts`, que captura el body HTTP real del AI SDK (baja `ai`/`@ai-sdk/anthropic` de npm la primera vez) y afirma que no viaje `temperature`/`top_p`/`top_k`, que Haiku 5.5 rechaza con 400.

## Arquitectura — el pipeline (lo más importante)

Mensaje entra a Kommo → llega al sistema y fluye así, **todo desacoplado por la tabla `inbound_queue` + Edge Functions encadenadas**:

```
Kommo webhook ──> kommo-webhook ──> inbound_queue (pending)
                                          │ (waitUntil)
                                          ▼
                   process-inbound: parsea payload, upsert leads, inserta
                   messages, clasifica inbound (CLASSIFY_MODEL, Haiku 5.5) (vertical +
                   intent/urgency/toxicity/requires_human_review) — con
                   contexto de los últimos turnos del lead
                                          │ (waitUntil, modo cola sin message_id)
                                          ▼
                   generate-response: DEBOUNCE 45s por lead → batch de
                   TODOS los mensajes sin responder + [HISTORIAL] determinístico
                   de la DB → sesión CMA (AGENT_MODEL, Haiku 5.5) con Memory Stores → 1 draft
                                          │ (si approved)
                                          ▼
                   publish-to-kommo: PATCH custom field configurado +
                   corre salesbot → evaluate-outcomes (graders)
```

Resiliencia: `pg_cron` barre cada minuto `process-inbound`, `generate-response`, `publish-to-kommo` (migraciones 0006/0007/0013) por si el fire-and-forget se corta. `dreams-run` (daily/weekly) y `evaluate-outcomes`/`alerts-scan` (cada 5 min) también por cron.

### Invariantes críticos (romperlos rompe producción)

1. **`verify_jwt = false` para TODAS las Edge Functions.** Kommo postea sin JWT; con `verify_jwt=true` da 401 y nada entra. En deploys por CLI, está fijado en `supabase/config.toml` bajo `[functions.*]`. En deploys desde el browser (wizard `/first-run`), se fuerza vía la metadata del API call: `{ verify_jwt: false }` en cada llamada a `POST /v1/projects/{ref}/functions/deploy` (ver `web/src/lib/provision/management.ts`). **Nunca quitar ninguno de los dos mecanismos.** `verify_jwt=false` NO significa «sin autenticación»: **todas las funciones salvo `kommo-webhook` exigen el header `x-internal-secret`** (`_shared/auth.ts` → `authorizeInternal`, comparación en tiempo constante, 401 genérico, fail-closed). El secreto es `INTERNAL_FUNCTION_SECRET` en la tabla protegida `_app_secrets` (0061: sin policies, sin grants a anon/authenticated; se genera por despliegue, nunca vive en el repo ni en el SQL). Lo mandan: pg_cron (las funciones `trigger_*`, SECURITY DEFINER, leen `internal_function_headers()`; 0069), las funciones entre sí (`callInternal`) y el servidor del panel (`lib/internal-call.ts`; ninguna ruta web lo expone al navegador ni usa la service key como Bearer). `kommo-webhook` es pública porque Kommo no firma sus webhooks ni puede presentar el secreto; sus mitigaciones están en el encabezado de su `index.ts`. **Toda función nueva** debe llamar a `authorizeInternal` (el test `gate-coverage.test.ts` falla si no) y figurar en `DEPLOY_ORDER`. **Orden de despliegue sin downtime** (lo hace el centro de actualizaciones): migraciones → funciones en `DEPLOY_ORDER` (invocadores antes que invocados: cuando una función empieza a exigir el secreto, quienes la llaman ya lo mandan) → web (si el secreto aún no existe llama sin header y la función vieja responde igual). Una llamada que caiga entre dos despliegues recibe 401 y la repone el barrido de pg_cron.

2. **El trabajo lento del agente va dentro de `EdgeRuntime.waitUntil()`.** `generate-response` crea el draft `pending`, devuelve **202 de inmediato**, y corre el agente (~60-80s) en `waitUntil`. Si se hiciera antes de responder, el runtime mata la función al desconectarse el cliente (pg_net/fire-and-forget) → draft `pending` eterno. Mismo patrón en `kommo-webhook`→`process-inbound` y `process-inbound`→`generate-response`.

3. **Debounce + batching.** `process-inbound` dispara `generate-response` en **modo cola** (sin `message_id`) para que aplique el debounce. `generate-response` espera 45s de silencio desde el último inbound del lead y responde TODOS sus mensajes pendientes en UN solo draft (resuelve los "3 mensajes cortados = una idea"). `messages.answered_by_draft_id` marca todo el batch como cubierto (FK `on delete set null` → si el draft se borra por stale, se reprocesan). Drafts `pending` con `agent_metadata.generating=true` >8min se consideran runs muertos: un barrido global al inicio del modo cola los borra (el FK libera su batch para reprocesar). El umbral es holgado adrede — runs vivos con muchos tool calls llegan a ~2.5min, y borrar un run vivo solo duplica trabajo (las guardas `status='pending'` en delete/update evitan perder o duplicar respuestas).

4. **Tres switches en `kommo_publish_config` (singleton `is_active=true`):**
   - `agent_enabled` — kill switch; si `false` `generate-response` no genera nada.
   - `publishing_enabled` — si `false`, drafts se generan pero NO se publican (shadow/validación).
   - `bypass_review` — si `true` (y `publishing_enabled=true`), el agente responde y publica TODO aunque entre a review. No afecta el botón de revisión humana (forceReview siempre queda `pending`).
   - Combinación de validación inicial: `agent_enabled=true, publishing_enabled=false`.

5. **`ignored_channels` ≠ "no clasificar" (migración 0052).** Un canal en `ignored_channels` que además esté en `classify_only_channels` SÍ se clasifica y SÍ se rutea al equipo — solo que el agente no le escribe al lead. La marca `ignored` se aplica **después** de clasificar (`generate-response` filtra por `ignored`, así que igual no responde). Si alguna vez tocás el gate de canal de `process-inbound`, el fallback del `select` de `getPublishFilters` es obligatorio: pedir una columna inexistente hace fallar el select entero y `channels` quedaría vacío → **el agente empezaría a responder en canales silenciados**.

6. **Migraciones con `${SUPABASE_URL}` placeholder.** Las migraciones que crean cron jobs (0006, 0007, 0009, 0010, 0011, 0013) usan `'${SUPABASE_URL}/functions/v1/<fn>'` en lugar de URLs hardcoded. La sustitución ocurre **en runtime** dentro de `web/src/app/api/provision/migrate/route.ts` antes de ejecutar cada SQL. El placeholder viaja intacto en los archivos `.sql` y en el archivo generado `migrations.generated.ts`. **No reemplazar el placeholder con la URL real en los archivos SQL** — dejá el placeholder para que el repo siga siendo reusable.

### Ruteo de leads al equipo comercial (migraciones 0052/0053)

Reparte automáticamente los leads de una vertical entre el equipo de ventas, y estampa un campo del lead en Kommo. Vive en `supabase/functions/_shared/routing.ts` y lo llama `process-inbound` justo después de clasificar (tanto en el hot path como en `recoverFailedClassifications`).

- **Disparador**: `verticals.auto_assign = true`. El campo a completar sale de `verticals.kommo_field_name` / `kommo_field_value`, resueltos **por nombre** (misma filosofía que las tools de 0028). Se edita en `/verticales`.
- **Decisión**: si el texto del lead contiene un término de `routing_assignees.match_terms` (ej: su sede) → esa persona (`term_match`). Si no → `round_robin` vía la RPC atómica `next_round_robin_assignee(key)`, que serializa la rueda con `SELECT … FOR UPDATE` (sin eso, dos inbounds simultáneos le dan el mismo lead a la misma persona). El match normaliza mayúsculas/acentos y exige límites de palabra — un `includes` pelado hacía que "coro" matcheara dentro de "recordar".
- **Nunca roba leads**: solo asigna si el responsable EN VIVO en Kommo es `null` o está en `kommo_publish_config.routing_takeover_user_ids` (las cuentas genéricas). Si no se puede leer el responsable, no asigna.
- **Un lead se rutea una vez** (`leads.routed_at`). Única excepción: si se ruteó por `round_robin` (una suposición, porque no había sede) y un mensaje posterior SÍ nombra la sede, se corrige **una sola vez** — y solo si el responsable sigue siendo el que puso el sistema. Un `term_match` no se toca nunca. Sin esto, el CRM decía una cosa y el agente (que comparte el WhatsApp de la asesora de esa sede) decía otra.
- **Umbral de confianza (0056)**: `kommo_publish_config.routing_min_confidence` (default 0.80). Si la clasificación viene con menos confianza, se clasifica igual pero NO se toca el CRM ni se marca el lead como ruteado (un mensaje claro posterior sí lo rutea). Motivo real: una charla interna de staff (facturas, un chofer) se clasificó `eventos_corporativo` con 0.65 y le asignó un lead falso a una asesora. Clasificar con dudas es barato y reversible; escribir en el CRM de una persona real, no.
- **Auditoría**: cada decisión —incluidas las salteadas— queda en `lead_routing_events` con estrategia, término, responsable previo y motivo. Sin eso el round robin es una caja negra ante el primer "a mí no me llegó ninguno".
- Switches en `kommo_publish_config`: `routing_enabled` (kill switch, default OFF) y `routing_takeover_user_ids`. El equipo se administra en Ajustes → Agente → Acciones → "Ruteo de leads al equipo".
- **Campos `select` de Kommo**: hay que mandar `enum_id`, no `value` — con un string arbitrario Kommo devuelve 200 y **no guarda nada**. Usá `patchEntityFieldTyped`/`resolveFieldValue` (`_shared/kommo.ts`). `patchLeadField` sigue existiendo solo para campos de texto/textarea.

### Texto del lead = entrada NO confiable (prompt injection)

Todo texto controlado por el lead que entra a un prompt pasa por `_shared/untrusted.ts` — **nunca** se interpola crudo. Cada turno es un elemento de UNA línea con el rol en un atributo que el lead no controla: `<turno rol="lead">…</turno>` / `<turno rol="agente">…</turno>`; el contenido se normaliza (NFKC, saltos de línea de cualquier tipo → ` ⏎ `, sin invisibles/bidi/control) y se escapa (`& < > "`), de modo que nada dentro de un turno puede cerrarlo, abrir otro ni imitar el prefijo `Agente:`. El prompt que lo consume antepone `UNTRUSTED_NOTICE` (solo `rol="agente"` es del sistema; las instrucciones dentro de turnos del lead no se obedecen). Aplica a: `[HISTORIAL]` y mensajes nuevos (generate-response), `lead_name` y `classifier_reasoning`, clasificador (`process-inbound`), seguimiento (`follow-up-scan`, que ahora usa `fetchLeadHistory`), transcripts de Dreams (que alimentan el digest persistente del agente), respuesta a comentarios y el juez LLM de `evaluate-outcomes` (`_shared/grader-prompt.ts`: mensaje del lead y respuesta del agente como turnos). `fetchLeadHistory` conserva firma y tipo (string) pero **el formato cambió** de `Lead:/Agente:` a turnos `<turno>`; todo consumidor propio debe anteponer `UNTRUSTED_NOTICE`. Tests: `untrusted.test.ts`, `history.test.ts`, `grader-prompt.test.ts`. Nuevos puntos de entrada de texto del lead → usar `turn()`/`sanitizeUntrusted()`.

### Sincronización segura del system prompt (`lib/agent-prompt-sync.ts`)

Todo camino que empuja el prompt al Managed Agent pasa por `syncAgentTools` (guardar en `/agent`, botón «Sincronizar» → `POST /api/agent/sync`, toggles de tools/CRM/BCV/Shopify, wizard `/setup`). **Antes de empujar** compara el system VIVO (`retrieveAgent`) contra `runtime_config.AGENT_PROMPT_SYNCED_HASH` (hash del system exacto enviado la última vez, junto con `ANTHROPIC_AGENT_VERSION`): si fue editado por fuera (consola de Anthropic, otra herramienta), o la versión viva es mayor que la registrada, o es la primera vez (sin hash) y difiere → **NO sincroniza**: 409 con el diff y la UI de `/agent` (`agent-prompt-conflict.tsx`) ofrece, de forma explícita, **importar el vivo a la plataforma** (`{resolve:"import_live"}`) o **sobrescribir con el de la plataforma** (`{resolve:"overwrite"}`). `/api/usage/models` también se frena ante un conflicto (cambiar el modelo sube la versión y taparía la señal). Tests: `web/src/lib/agent-prompt-sync.test.ts` (`pnpm test` en `web/`). Efecto al actualizar un cliente ya desplegado: la primera sincronización lo trata como conflicto si difiere (no hay hash registrado) — se resuelve una vez con «Sobrescribir» o «Importar».

### Texto saliente: un único verificador y un único «lo enviado» (`_shared/outbound.ts`)

- **`draftText(d)` = `edited_body` (si no está vacío) o `body`** (`_shared/draft-text.ts`; copia exacta en `web/src/lib/draft-text.ts`). Es lo que se PUBLICA. Antes `publish-to-kommo` y su guard leían solo `body`: lo que el operador corregía en el inbox NUNCA llegaba al cliente. Lo usan publish-to-kommo, el guard, el historial, Dreams, los graders y el inbox; **nunca** `d.body` ni `edited_body ?? body` a mano.
- **Todo texto a Kommo sale por `outbound.ts`**: `writeClientText` (DM, respuesta pública a comentarios de IG, variables del seguimiento) y `writeCrmField` (valores que el modelo elige en las tools de CRM) verifican con `detectInternalLeak` ANTES de tocar la API y lanzan `OutboundBlockedError`. Ningún otro código llama a `patchLeadField`/`patchContactField`/`runSalesbot` (el test `outbound.test.ts` falla si aparece un camino sin verificar).
- Comportamiento: **fuga en el DM** → el draft vuelve a `pending` con `guard_blocked` (se verifica ANTES de publicar la parte pública, para no duplicar el comentario al reaprobar). **Fuga solo en la pública** → se omite la pública, el DM sale si está limpio, el draft queda marcado `guard_part=public_reply` y alerta `outbound_blocked` (0068; sale también al webhook de alertas). **Seguimiento** → `failed` con el motivo, alerta y cooldown (se verifican todas las variables antes de escribir la primera). `generate-response` aplica el mismo verificador a la respuesta pública al generarla. El inbox muestra el motivo y marca «editado».

### EXECUTE de las funciones SQL (la anon key es pública)

Postgres da EXECUTE a PUBLIC en toda función nueva y Supabase agrega default privileges para anon/authenticated: una función con EXECUTE para `anon` la invoca cualquiera con la URL del proyecto, y una SECURITY DEFINER bypasea la RLS. Las migraciones **0063** (ya aplicada en producción), **0070** y **0072** cierran todo: REVOKE de PUBLIC/anon/authenticated sobre TODAS las funciones propias de `public` (las de pgvector/pg_trgm, que viven en `public`, no se tocan), GRANT explícito a `service_role` y, a `authenticated`, solo lo que el panel llama por RPC con la sesión (`inbox_lead_summaries`, `gasto_mes_actual`); `ALTER DEFAULT PRIVILEGES` para que las futuras no nazcan abiertas. Las SECURITY DEFINER llevan `set search_path = public, pg_temp` y un guard interno (`end_user_request()`: rechaza peticiones con claims de usuario aunque alguien re-otorgue EXECUTE). **Función SQL nueva** → si la usa el panel con la sesión, `grant execute … to authenticated` explícito en SU migración y agregarla a la lista de `supabase/tests/function_execute.sql`; si la usan Edge Functions/cron, nada (service_role ya la tiene por default privileges). Prueba: `supabase/tests/function_execute.sql` (y `claim_kommo_backfill.sql`) contra un Postgres con todas las migraciones aplicadas.

### Techo de gasto mensual (`MONTHLY_BUDGET_USD`)

Segunda red de seguridad, independiente de los frenos por lead (cooldown / máx. respuestas): corta un gasto AGREGADO disparado (ráfaga de leads, cambio de modelo/precio, un bug). Ausente o `0` en `runtime_config.MONTHLY_BUDGET_USD` = **sin freno** (default; no cambia ningún despliegue existente). Se edita desde `/consumo` → "Techo de gasto mensual" (`/api/usage/budget`, alcance **configuracion** en `lib/auth/roles.ts`, igual que `/api/usage/models`; la UI deshabilita el control sin ese alcance). Claves: `MONTHLY_BUDGET_USD`, `BUDGET_SAFETY_MARGIN_PCT` (0..50, default 0) y `BUDGET_EXCLUDE_BEFORE` (activar a mitad de mes sin contar lo ya gastado).

- **Es una ESTIMACIÓN**: el gasto = `gasto_mes_actual()` (migración 0060) = suma de `usage_events.estimated_cost_usd` del mes UTC. Las sesiones CMA se valúan a tarifa base y con el modelo REAL de la sesión (`agent.model` del GET de sesión, no `AGENT_MODEL`): es cota inferior si una request interna supera 100K tokens. El margen de seguridad adelanta los cortes para compensarlo.
- **La ingesta NUNCA se frena** (leads, mensajes, etapas, pipelines: el inbox sigue vivo y `health-scan` no ve un falso "ingesta detenida"); solo se frenan las llamadas al modelo:
  - **≥100%**: `generate-response` y `follow-up-scan` no reclaman nada (los mensajes se responden al reanudar; `force_review` desde el inbox no se bloquea), y `evaluate-outcomes` (graders LLM) y `dreams-run` se omiten (se reintentan solos).
  - **≥110%**: `process-inbound` guarda el mensaje pero omite el clasificador y lo marca `classification.error = "budget: …"` (sin prefijo `recover:`); `recoverFailedClassifications` lo reclasifica solo al reanudar (y no reclasifica mientras el gate esté cerrado). `answer_max_age_hours` evita contestar mensajes viejos.
- `_shared/budget.ts`: cache 60s (se invalida al cambiar techo, margen o `BUDGET_EXCLUDE_BEFORE`) y **fail-open absoluto**. El aviso lo emite `alerts-scan` (`budget_exceeded`, una alerta ABIERTA por mes y nivel, con webhook) y **se resuelve sola** al cambiar de mes, subir/quitar el techo o bajar el gasto.

### Agente vivo desactualizado (scaffold / modelo)

`syncAgentTools` guarda `runtime_config.AGENT_SCAFFOLD_HASH` (huella del `CORE_SCAFFOLD`) al empujar el system prompt. Si el código se actualiza y la huella no coincide, o si el modelo vivo en Anthropic difiere de `AGENT_MODEL`, Ajustes → Agente (`/settings`) y `/consumo` muestran un banner con botón **Sincronizar** (`POST /api/agent/sync`, alcance configuracion; no toca `SYSTEM_PROMPT`). **No se sincroniza solo** a propósito: un sync sube la versión del agente en producción y dispararlo desde el render de una página GET sería un efecto secundario concurrente y no decidido por nadie. `/consumo` también muestra el modelo vivo junto al selector.

### Modelos: Haiku 5.5, thinking, effort y refusals

Todo el LLM del template corre en **Haiku 5.5** (`claude-haiku-5-5`) por defecto; cada componente es intercambiable desde `/consumo`. Defaults en **dos** lugares que deben coincidir: `web/src/lib/model-config.ts` (`MODEL_KEYS`) y `supabase/functions/_shared/models.ts` (`MODEL_DEFAULTS`) — `supabase/tests/web-parity.test.ts` lo verifica. Agregar un modelo = `ALLOWED_MODELS` + `MODEL_LABELS` + `MODEL_NAMES` + fila en `AI_PRICING` (ambas copias).

- **Precio escalonado** (`ai-pricing.ts`, DOS copias idénticas — `supabase/tests/web-parity.test.ts` verifica paridad): Haiku 5.5 = $0.10/$0.50 por MTok (cache read $0.01, write 5m $0.125, 1h $0.20) si el prompt de la request es ≤100K tokens; si lo supera, **toda** la request paga $0.50/$2.50 (read $0.05, write $0.625/$1.00). El largo del prompt cuenta input + cache read + cache write. Las filas de sesión CMA son agregados de varias requests → se marcan `aggregated: true` y se valúan a tarifa base (cota inferior). Tokenizer nuevo: ~30% más tokens que Haiku 4.5 para el mismo texto.
- **Adaptive thinking viene ACTIVO** y cuenta contra `max_tokens`. Nunca leer `content[0]`: `_shared/llm.ts` (`textOf`/`jsonOf`) toma el bloque de texto y tira errores tipados ante `stop_reason: "refusal"` (`LlmRefusalError`), `"max_tokens"` (`LlmTruncatedError`) o ausencia de texto (`LlmEmptyError`). Cada call site usa un perfil de `LLM_PROFILES` (effort explícito + `max_tokens` con holgura): classify=low/4096, grader=medium/4096, comment_reply=low/2048, dreams learnings=medium/16000, digest=low/8000. El `effort` se arma SIEMPRE con `effortFor(model, …)` (`_shared/models.ts`): Haiku 4.5 (histórico, aún asignable) lo rechaza con 400, así que no se envía. Las llamadas fallidas (refusal/corte) igual se registran en `usage_events` (`recordFailedLlmUsage`) para que el techo de gasto no las subestime. No enviar `temperature`/`top_p`/`top_k`/`budget_tokens` (400 en Haiku 5.5); no hay `fallbacks` server-side para refusals.
- **Fallas**: classify con refusal o corte por `max_tokens` → `requires_human_review` + `classification.error = "recover: …"` (sale de la cola de reintentos; determinístico); comment_reply → sin respuesta pública (el DM sale igual); grader → outcome con `ERROR` visible; dreams → el run falla y el digest vivo NO se pisa.
- **Managed Agent**: `model` se envía como objeto `{id, effort}` (`web/src/lib/model-capabilities.ts`, `AGENT_EFFORT="medium"`), tanto al crear (`/api/setup/agent`) como al cambiar de modelo (`/api/usage/models`, que compara contra el agente VIVO, no contra `runtime_config`). Haiku 4.5 (histórico) no admite effort → string plano.
- **Rutas AI SDK del dashboard** (`lib/dashboard-ai.ts` + `lib/model-capabilities.ts`): `ai@4` mandaba `temperature: 0` por DEFAULT (Haiku 5.5 lo rechaza con 400) y no expone `output_config.effort`; un `fetch` envuelto (`shapedFetch`) normaliza el body según `MODEL_CAPS` (quita sampling, inyecta effort). `MODEL_CAPS` está duplicada en `_shared/models.ts` (paridad testeada). `generateObject` fuerza tool_choice (Haiku 5.5 lo acepta y no emite thinking). El dashboard ya corre `ai@5` (pin exacto 5.0.267 + `@ai-sdk/anthropic` 2.0.106); el wrapper se mantiene solo para `output_config.effort` y quitar sampling que Haiku 5.5 rechaza.

### Memoria y aprendizaje (Anthropic Managed Agents)

- Dos Memory Stores montados como filesystem en la sesión CMA. Sus nombres reales se configuran vía env vars (`MEMORY_STORE_MASTER_NAME` / `MEMORY_STORE_LEADS_NAME`):
  - **master** (read-only, global a todos los leads): `/voice/` (voz), `/kb/` (KB destilada), `/dreams/` (aprendizajes).
  - **leads** (read-write, por lead): solo `/<lead_id>/learnings.md` (datos duraderos del lead; el agente lo escribe únicamente si aprendió algo nuevo). **`conversation.md` ya NO se lee ni se escribe**: el historial viaja en el `[CONTEXTO]` (ver abajo). Los `conversation.md` de leads viejos quedan huérfanos e inocuos. **Al desplegar esto en un cliente existente**: (1) botón **Sincronizar** del banner en `/agent` o `/consumo` (o volver a guardar `/agent`) para que `syncAgentTools` suba el scaffold nuevo a Anthropic — hasta entonces el agente vivo sigue con el viejo, que contradice las `instructions` de sesión; (2) las `description` de los Memory Stores solo se escriben al crearlos: en stores ya creados conservan el texto viejo (cosmético; mandan las `instructions` por sesión); (3) si el `SYSTEM_PROMPT` del cliente tiene sus propios pasos de leer/escribir `conversation.md` o leer `/dreams/`, retirarlos.
- En el código (web + edge) usamos los labels semánticos `"master"` y `"leads"` para no acoplar el schema a un nombre específico de store. El ID real viene de `ANTHROPIC_MEMORY_MASTER_ID` / `_LEADS_ID`.
- **Historial determinístico de la conversación** (`supabase/functions/_shared/history.ts`): el contexto conversacional NO depende de que el modelo escriba/lea `conversation.md` (un tool call que el CMA podía omitir → respuestas sin contexto, y el mayor costo de tokens por respuesta). `fetchLeadHistory` reconstruye el transcript real Lead/Agente desde `messages` + `drafts` (join `drafts!messages_answered_by_draft_id_fkey`, mismo patrón que `dreams-run`; solo cuenta drafts `sent`/`auto_sent`). `generate-response` lo inyecta como bloque `[HISTORIAL]` (~24 turnos) antes de los mensajes nuevos; `process-inbound` le pasa al clasificador los últimos ~6 turnos para desambiguar (`"sí, dale"`, `"y cuánto?"`). `fail-soft`: ante error devuelve `""` y cae al comportamiento previo. Es la ÚNICA fuente del historial: `agent-prompt.ts` (CORE_SCAFFOLD), las `instructions` de los Memory Stores (`_shared/memory-instructions.ts`, compartidas por `generate-response` y `follow-up-scan`) y `agent/system-prompt.example.md` ya no piden leer/reescribir `conversation.md` ni leer `/dreams/`. `learnings.md` queda para datos duraderos. Dreams (daily y weekly) arma su insumo desde `messages` + `drafts` (la historia determinística de la DB), así que dejar de volcar a `conversation.md` no le quita materia prima. Tocar esas instrucciones sin mantener la coherencia con el `[CONTEXTO]` reintroduce el costo: `memory-instructions.test.ts` lo vigila.
- **Dreams**: `dreams-run` analiza conversaciones (24h/7d), DREAMS_MODEL (Haiku 5.5) destila learnings y los escribe como `.md` en `<master>/dreams/`. **El agente ya NO lee `/dreams/` por filesystem** (con muchos archivos activos eso costaba listado + lecturas + turnos extra en CADA respuesta): tras cada corrida, `dreams-run` consolida los dreams en el digest que ve el agente (`rebuildDigest`, `runtime_config.DREAMS_DIGEST`, tope `DREAMS_DIGEST_MAX_WORDS` 300–3000, default 900). **Dos piezas de estado, a propósito**: `DREAMS_ARCHIVE_DIGEST` (esencia de lo ya archivado — lo ÚNICO que «rueda» entre corridas) y `DREAMS_DIGEST` = consolidación de (resumen archivado + dreams ACTIVOS de ahora), que NUNCA se realimenta con el digest anterior (`_shared/dreams-consolidation.ts` no recibe un digest previo: **borrar un dream lo saca del digest en el siguiente rebuild por construcción**; antes su regla seguía viva dentro del digest anterior). El archivado consolida la esencia ANTES de borrar nada. «Gana la última en empezar» (`DREAMS_DIGEST_RUN`): un rebuild lento no pisa a uno más nuevo. `digest_only` y el rebuild de las corridas del cron van en `EdgeRuntime.waitUntil` (202) (la llamada al modelo se **omite si nada cambió**: `runtime_config.DREAMS_DIGEST_FINGERPRINT` guarda un hash del set de dreams activos post-archivado + el resumen archivado + el digest vigente + modelo + `DIGEST_PROMPT_VERSION` + tope de palabras; `_shared/dreams-digest-fingerprint.ts`. Cualquier aprobar/borrar/importar/editar cambia el hash y el `digest_only` reconstruye; el fingerprint y el digest previo se leen FRESCOS de la DB, no del cache de 60s; si cambiás el prompt de consolidación, subí `DIGEST_PROMPT_VERSION`; con exceso sobre `DREAMS_MAX_ACTIVE` nunca se omite porque el archivado va por tandas), y `generate-response` lo inyecta al contexto de cada sesión como bloque `aprendizajes_del_operador` (**prioridad mayor que la voz base**, TTL 60s, sin re-sync). Las mutaciones del dashboard (aprobar/borrar/importar) disparan `dreams-run {digest_only:true}` fire-and-forget (`triggerDigestRebuild`, `lib/memory-list.ts`) para que el cambio llegue al agente en <60s. Cota de activos: `DREAMS_MAX_ACTIVE` (default 60) — el exceso más viejo se archiva a `/dreams-archive/` (fuera del dashboard y de futuras consolidaciones; su esencia persiste en `DREAMS_ARCHIVE_DIGEST`, en tandas de `ARCHIVE_BATCH=50` por corrida para no exceder los recursos del worker). Cada learning lleva `severity` (sugerencia|advertencia|error, codificada también en el filename como `sug|adv|err`) y la política `runtime_config.DREAMS_AUTO_ACTIVATE` decide qué se activa solo: `all` (default), `error` (solo errores se auto-activan = autocorrección; el resto espera aprobación) o `none`. Lo no activado va a `/dreams-pending/` (no entra al digest) y se aprueba/descarta desde `/dreams`. Todo dream `error` genera una alerta (`kind=dream_error`). Borrar un activo lo saca del digest en el próximo rebuild (<60s).
- **Audio (notas de voz)**: si `respond_to_audio=true` y hay `OPENAI_API_KEY` en `runtime_config`, `process-inbound` transcribe con Whisper (`whisper-1`) y el texto sigue el pipeline normal (se guarda como `🎙️ <transcript>`). Sin key → `media_audio_no_key`; transcripción fallida → `requires_human_review`. La key se pide al activar el toggle en `/agent` → Filtros → Multimedia.
- `search_kb` es un custom tool del agente: embeddings gte-small 384d (`embed` function) + RPC `search_kb` (vector 0.7 + FTS español 0.3).
- Captura de mensajes salientes manuales de Kommo: **no resuelto**. El webhook `leads.add` no trae texto; los mensajes tecleados a mano viven en el sistema de chat de Kommo (amojo, credenciales aparte). Lo único recuperable vía API es lo que pasa por el custom field configurado (eventos `/api/v4/events`).

### System prompt del agente

El system prompt vivo está en `runtime_config.SYSTEM_PROMPT` (DB), editable desde el dashboard en `/agent`. Soporta placeholders que se sustituyen al sincronizar con Anthropic:
- `{{OPERATOR_NAME}}` — de `runtime_config.OPERATOR_NAME`.
- `{{MASTER_PATH}}` / `{{LEADS_PATH}}` — `/mnt/memory/<MEMORY_STORE_*_NAME>`.
- `{{MEMORY_STORE_MASTER}}` / `{{MEMORY_STORE_LEADS}}` — nombres de los stores.

Además del prompt global, **cada vertical puede tener su propio prompt** (`verticals.system_prompt`, editable en `/verticales`): `generate-response` lo inyecta en el contexto como `instrucciones_de_la_vertical`, por debajo de `aprendizajes_del_operador`. (Hasta agosto 2026 ese campo se editaba pero NINGUNA Edge Function lo leía: las instrucciones por vertical no llegaban nunca al agente.)

La sustitución y la lista de tools viven en `web/src/lib/agent-prompt.ts` (compartidas por `/api/agent` y `/api/setup/agent`). Guardar en `/agent` llama `anthropic.beta.agents.update()` y persiste la versión nueva en `runtime_config.ANTHROPIC_AGENT_VERSION`. `agent/system-prompt.example.md` (commiteado) es el template de partida para copiar/pegar al wizard; el prompt vivo está en `runtime_config.SYSTEM_PROMPT`.

### Front (Next.js App Router)

- **Resilient boot**: el middleware (`src/middleware.ts` → `lib/supabase/middleware.ts`) detecta la ausencia de env vars de Supabase y redirige todo (excepto `/first-run/**`, `/api/provision/**`, `/_next/**`, `/favicon.ico`) al wizard de configuracion inicial. Nunca lanza un 500 aunque el entorno esté vacío.
- **`/first-run/` invariante**: ningún archivo bajo `web/src/app/first-run/` ni bajo `web/src/app/api/provision/` puede importar `@/lib/runtime-config` ni `@/lib/supabase/service` — ambos módulos lanzan si las vars de entorno no están presentes. Los componentes y routes de provision construyen sus clientes inline con `createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, ...)`.
- **Onboarding no bloqueante (setup drawer)**: el wizard de config del agente (Anthropic/Agent/Verticales/Memoria/Kommo) NO es una página full-screen — vive como panel lateral derecho montado en `(dashboard)/layout.tsx` (`setup-drawer.tsx`, client). El layout computa el estado server-side con `getSetupState()` (`lib/setup-state.ts`, DB-only) y lo monta **solo para admins fuera de embed**. El drawer se auto-abre 1x por sesión si falta config (guard en `sessionStorage`), ofrece un launcher flotante y respeta `?setup=open`. `/setup` es solo un `redirect("/inbox?setup=open")` — los links "corré /setup" dispersos siguen funcionando. Reusa las mismas rutas `/api/setup/*` que el wizard anterior.
- El `(dashboard)/layout.tsx` hace `getUser()` (hay 2 round-trips de auth por navegación — optimización pendiente conocida). El maestro lo crea el `/first-run`; a partir de ahí los usuarios se administran desde `/usuarios` (ver «Quién entra y hasta dónde»).
- Todas las páginas del dashboard son `export const dynamic = "force-dynamic"`. Hay `loading.tsx` (grupo + inbox) que dan feedback instantáneo vía Suspense.
- **Realtime**: `messages`/`drafts`/`leads`/`alerts`/`lead_stage_events` publicados (migración 0008/0011/0061). La lista/tablero del inbox se recarga agrupando eventos cada 5 s (`inbox-shell.tsx`); la conversación abierta hace `router.refresh()` solo con SU lead (`conversation-realtime.tsx`).
- **Inbox = tablero kanban por pipeline de Kommo + vista Lista** (`(dashboard)/inbox/`). La lista/tablero vive en el **layout** (`inbox-shell.tsx`, cliente: pide `/api/inbox/leads` → `inbox_lead_summaries()`, filtra/ordena en el cliente) y la conversación en `/inbox/[leadId]` (server component, consultas en paralelo; la etapa viva de Kommo llega en un `Suspense`). Vista (`?vista=lista`) y pipeline (`?pipeline=<id>`) viven en la URL; los links viejos `/inbox?lead=<id>` redirigen (`next.config.mjs`). Filtros: `filters.tsx` (prop `shallow` = cambia la URL sin ir al servidor; `collapsible` pliega en móvil); los filtros se conservan al abrir una conversación (`filterQS`).
- **Mover etapa** (tarjeta arrastrada o «Mover a…» en la conversación, que es la vía en móvil y para cambiar de pipeline): `POST /api/leads/[id]/stage` → **Kommo primero** (`moveLeadInKommo`: `status_id` + `pipeline_id`, SIEMPRE ambos) y luego `leads.kommo_stage_id/kommo_pipeline_id` + evento. UI optimista con vuelta atrás si Kommo falla.
- **142/143 (ganado/perdido) existen en TODOS los pipelines**: la etapa sola no ubica un lead. Por eso `leads.kommo_pipeline_id`, `kommo_stages` con clave compuesta `(pipeline_id, id)` y `lead_stage_events.pipeline_id/from_pipeline_id`. Todo código que escriba la etapa de un lead (webhook, agente, panel, backfill) escribe también el pipeline.
- **Un movimiento = un evento**: lo reportan la fuente (agente/panel) y el eco `leads.status` de Kommo, en cualquier orden. TODOS pasan por `record_lead_stage_event()` (0061, advisory lock por lead + ventana de 120 s), que completa el evento existente en vez de duplicarlo. No insertar en `lead_stage_events` a mano.
- **Pipelines/etapas locales y backfill**: `kommo_pipelines`/`kommo_stages` son un espejo de Kommo que escribe SOLO `sync_kommo_pipelines()` (service_role). La Edge Function `sync-pipelines` (cron `*/10`, gate `x-internal-secret`, o botón «Sincronizar» → `POST /api/inbox/sync`) refresca el espejo y rellena `kommo_pipeline_id`/`kommo_stage_id` de los leads existentes paginando `/api/v4/leads` (~4 req/s, reintento en 429, lease en `kommo_backfill`, reanudable). Corre sola tras aplicar 0061 hasta quedar `done`; estado: `select * from kommo_backfill`.
- **Quien decide un reinicio es la BASE (`claim_kommo_backfill`), nunca el caller**: el botón solo *pide* `restart`. Un recorrido `pending`/`running`/`failed` se **retoma** desde su cursor (jamás se rebobina); un reinicio solo se concede con el recorrido `done` y pasados **15 min** desde su último movimiento (`updated_at`); antes responde `cooldown` + `retry_after_seconds`, y con el lease vivo `busy`. Así clics repetidos, varias pestañas o un usuario con scope `operacion` no pueden mantener un recrawl de Kommo (cuota ~7 req/s compartida con webhook y agente). Resultado visible en la respuesta de `/api/inbox/sync` (`backfill.state`: `started|continuing|busy|cooldown|idle`) y en el botón (deshabilitado mientras hay un recorrido en marcha; el tooltip dice cuándo se puede volver a recorrer). El freno de 30 s del refresco de pipelines también es de la base (`claim_kommo_pipelines_refresh`, tabla `kommo_sync_state`), no memoria de la instancia. El `restart` manual de emergencia (`claim_kommo_backfill('lead_positions', 150, true)`) respeta el mismo enfriamiento.
- **Leads borrados en Kommo** (`leads.kommo_missing_at`): NUNCA se marca por ausencia en un recorrido. Los candidatos (`kommo_missing_candidates`) se VERIFICAN por id contra Kommo (`filter[id][]`) y solo los que Kommo confirma inexistentes se marcan con `mark_kommo_leads_missing`; un error o 429 deja el lead sin marcar. El gap-fill de leads sin pipeline también va por ids (`kommo_gap_lead_ids`), sin recorrer Kommo cada hora. Orden de eventos: `leads.kommo_position_at` guarda el instante del último evento aplicado y `apply_lead_position()` es el ÚNICO camino que escribe etapa+pipeline (webhook, panel, backfill, reconciliación): ignora eventos más viejos que `kommo_position_at`, así un backfill lento no pisa un movimiento más reciente. Cualquier señal de vida limpia la marca (webhook, mensaje, movimiento desde el panel, volver a verlo). El tablero los muestra en la pestaña «No existe en Kommo». Pruebas: `supabase/tests/claim_kommo_backfill.sql` (Postgres descartable con todas las migraciones).
- **SuperCines sobre el inbox nuevo**: la vista **Lista** conserva las pestañas por etapa «Con agente / Apagadas / Todas» (`?etapa=`, calculadas en el cliente con `ignored_stage_ids`; el tablero NO las aplica: es el espejo completo de Kommo y cada tarjeta marca con un punto si el agente está apagado en su etapa), las métricas compactas del topbar (siempre sobre el inbox completo), el aviso de adjunto ilegible (`media_status`), el estado «escribiendo…» del borrador vacío y `system_halted` en consulta aparte con fail-open. `NavProgress` reconoce `/inbox/<id>` (los links viejos `/inbox?lead=<id>` redirigen). Mover etapa exige alcance `operacion` (`/api/leads`, `/api/inbox` en `PATH_SCOPES`): es lo mismo que la asesora hace a mano en Kommo.
- **Volumen de `leads.update` (Salesbots)**: `kommo-webhook` dispara `process-inbound` al instante solo con `leads.status`/`leads.add`/`message.add`; los `leads.update` (custom fields del bot, miles) solo se encolan y los procesa el barrido de pg_cron cada minuto. `syncLeadPositions` hace UNA consulta por payload y escribe solo si cambió la etapa/pipeline (cada UPDATE a `leads` refresca los inbox abiertos). `kommo-funnel-sync` reutiliza su lectura de las 3 sedes para reconciliar la posición (`reconcile_funnel_lead_positions`, 0062): una sola fuente de verdad, sin recorrer Kommo dos veces; ahora exige `x-internal-secret`.
- Filtros de Leads: server-side por `searchParams` (`/leads` sigue siendo el archivo completo).
- RLS en todas las tablas: `authenticated` tiene acceso total — los tres alcances por igual. **Ojo: la RLS NO distingue alcances**; ver la nota al final de «Quién entra y hasta dónde». `service_role` (Edge Functions) bypassea.
- Branding: el título del dashboard se resuelve **DB-first** (`runtime_config.NEXT_PUBLIC_AGENT_LABEL`, editable en `/agent`) en `(dashboard)/layout.tsx` y se pasa como prop al `nav` — NO depende del inlining build-time de `NEXT_PUBLIC_AGENT_LABEL`. Fallback al env var y, si no, default "Agente". El login sí usa el env var build-time.

### Quién entra y hasta dónde (gestión de usuarios)

`/usuarios` (alcance `configuracion`) administra quién tiene acceso al panel: crear,
cambiar el alcance, resetear la contraseña y borrar. Se apoya en la Admin API de Supabase
Auth con la service-role key (`web/src/lib/users/admin.ts`, server-only).

**El alcance vive en `app_metadata.role`** de Supabase Auth, que sólo se escribe con
service-role: viaja firmado en el JWT y se lee sin round-trip a la base.

**Tres alcances acumulativos** (`web/src/lib/auth/roles.ts`, el único lugar donde se decide):
`operacion` (Inbox, Leads, Alertas) ⊂ `contenido` (+ contenido y calidad) ⊂ `configuracion`
(+ credenciales, Kommo, herramientas, seguimiento, ajustes, usuarios). `admin` y `editor`
se siguen leyendo como alias (`admin`→`configuracion`, `editor`→`contenido`), así que ningún
usuario existente gana ni pierde acceso; ya no se escriben.

- **El gate está en el MIDDLEWARE, y vale para páginas Y `/api/*`.** `nav.tsx` OCULTA, el
  middleware PROHÍBE. Ocultar un ítem del menú no es un permiso: la ruta se sigue alcanzando
  escribiendo la URL.
- **Un valor desconocido cae CERRADO**, al alcance más restrictivo. Sólo la AUSENCIA de rol
  abre del todo, y es el maestro del `/first-run`. El código legado hacía lo contrario:
  `r === "editor" ? "editor" : "admin"`, o sea que un typo en el campo regalaba acceso total.
- **Una ruta que no esté en `PATH_SCOPES` NO queda protegida: queda ABIERTA**, y en silencio
  —`scopeRequeridoPara` devuelve `null` y no se rompe nada—. Por eso `web/scripts/check-scopes.mjs`
  corre en `prebuild`/`predev` y **rompe el build** ante una página o ruta de API sin alcance
  declarado. No es paranoia: en KIA-Agente, del mismo template, la lista quedó vieja y
  `/api/promotions`, `/api/kb` y `/api/voz` quedaron alcanzables por cualquiera con sesión.
- **No podés bajarte el alcance a vos mismo ni borrarte**, ni dejar el panel sin ningún
  `configuracion`: la única salida sería la Admin API de Supabase con la service-role key.
- **LO QUE ESTO NO CUBRE.** Es una frontera de RUTAS, no de DATOS. La RLS sigue siendo
  `authenticated_all`, así que alguien con sesión puede saltarse el middleware hablándole
  directo a PostgREST con la anon key (pública por diseño) y su propio JWT. Cerrarlo exige
  políticas RLS por alcance, con funciones SQL que copien **exactamente** `getScope`/
  `scopeAlcanza` — hay una implementación de referencia en `Vitalicia-Agente`, migración
  `0062_rls_por_alcance.sql`. Una discrepancia entre las dos capas es peor que no tener la
  segunda, porque da por protegido lo que no lo está.


## Convenciones y gotchas

- **`runtime_config` es la single source of truth** para credenciales e identidad por cliente (migración 0017/0018). Web y Edge leen DB-first/env-fallback; ya NO hace falta publicar secrets de Anthropic/Kommo vía Management API ni mantener los mismos valores en `web/.env.local` y en secrets de Supabase — el wizard `/first-run` + `/setup` los escribe una vez en DB. Lo único irreducible en el host como env vars: los 3 secretos de arranque de Supabase (URL, anon, service-role) que se necesitan para leer la DB. **Tradeoff de seguridad**: las credenciales en `runtime_config` están en texto plano, protegidas solo por RLS (acceso `authenticated` + `service_role`). Cifrado pgcrypto queda diferido a una iteración futura.
- Las nuevas keys de Supabase (`sb_publishable_*` / `sb_secret_*`) **no** funcionan con la REST API PostgREST (espera JWT de 3 partes). Para llamar la REST API usar las legacy JWT keys (`/v1/projects/<ref>/api-keys`).
- Edge Functions: Deno, imports por URL/`npm:`; el cron las invoca vía `net.http_post` (pg_net). Status `drafts`: `pending|approved|sent|rejected|auto_sent|failed`.
- Tras cambiar `web/.env.local` hay que **reiniciar** `pnpm dev` (Next lee env al arrancar). Cambiar secrets de Edge Functions NO requiere redeploy (se leen en runtime).
- UI en español, light theme. Sistema de diseño: tarjetas `rounded-xl border border-neutral-200 bg-white shadow-sm`, botón primario `bg-neutral-900 text-white rounded-lg`, badges `rounded-full text-[11px]`, tablas con `overflow-x-auto min-w-[640px]`, responsive a 375px (sidebar → drawer móvil en `(dashboard)/nav.tsx`).
- **Numeración de migraciones (SuperCines)**: hay DOS archivos `0058_*` (`claim_inbound_batch_created_at` y `salesbot_funnel`); `_migrations` registra por NOMBRE DE ARCHIVO (PK `filename`) y el orden es léxico, así que conviven sin colisión — **no renombrar ninguno ya aplicado** (se reaplicaría). Las portadas del template van con el siguiente número libre. Mapa SuperCines ← template: `0060_budget_gate` ← 0066, `0061_kommo_pipelines_board` ← 0065, `0069_internal_function_gate` ← 0067, `0070_function_execute_hardening` ← 0068, `0071_system_incidents` ← 0062 (el del template), `0064_claim_message_batch` ← 0060, `0065_alert_kinds_webhook` ← 0057, `0066_retention_and_indexes` ← 0055+0056, `0067_crm_tools_extra` ← 0058, `0068_alert_kind_outbound_blocked` ← 0069. Propias de SuperCines: `0062_funnel_sync_positions`, `0063_revoke_anon_functions`, `0072_revoke_anon_tables`. Al sincronizar con el template, mapear a mano. Las migraciones 0006 y 0053 no son re-aplicables (cambian el tipo de retorno de una función): se aplican UNA vez, que es lo que hace el migrador.
- **Seguridad de la base y de las funciones**: `anon` (clave pública) no tiene EXECUTE sobre ninguna función de `public` (0063/0070) ni privilegios sobre ninguna tabla (0072), ni las futuras (default privileges). TODAS las Edge Functions salvo `kommo-webhook` exigen `x-internal-secret` (incluidas `kommo-funnel-sync`, `cartelera` y `health-scan`); `cartelera` es una tool http del agente y `generate-response` adjunta el secreto solo cuando la URL apunta a `/functions/v1/` propio (nunca queda en `agent_tools.headers`, que lee cualquier usuario del panel). Las pruebas SQL de `supabase/tests/` y `gate-coverage.test.ts` fallan si algo vuelve a quedar abierto.
- **Salud de plataforma** (`health-scan`, 0071): incidentes que dejan al agente MUDO (webhook de Kommo caído, token inválido, ingesta detenida, cola atascada) en `system_incidents`; franja arriba de todo (`system-banner.tsx`) y panel «Torre de control» (`torre-de-control.tsx`, bandeja de alertas). VER lo hace cualquiera; ACTUAR (reconectar el webhook, omitir la cola, silenciar) exige `configuracion` (`/api/incidents`, `/api/kommo`). `/seguimiento` suma «Envíos recientes» con reintento puntual (`POST /api/follow-up/retry` → `follow-up-scan {lead_id, force}`).
- **Dashboard en Next 15 / React 19 / ai@5**: `params`, `searchParams`, `cookies()`, `headers()` y `createSupabaseServerClient()` son asíncronos (`tsc` NO detecta los `searchParams`/`params` síncronos de páginas y rutas: lo valida `pnpm build`). `packageManager` pnpm@10.32.1 + `PNPM_VERSION` y `NODE_VERSION=22` en `netlify.toml` (con pnpm < 10.6 el install frozen falla). Los overrides de dependencias transitivas viven en `web/pnpm-workspace.yaml` (pnpm ≥ 10 ignora `pnpm.overrides` de package.json). `maxOutputTokens` explícito en toda ruta AI (el provider v2 no conoce Haiku 5.5 y manda 128000). `pnpm audit --prod` debe dar 0.
- Migraciones: numeradas `00NN_nombre.sql`, idempotentes (`if not exists`), registradas en tabla `_migrations`. URLs absolutas usan `${SUPABASE_URL}` que sustituye el route handler de migrate en runtime.

## Customización por proyecto

| Cosa | Dónde |
|---|---|
| Voz / system prompt del operador | Dashboard `/agent` (→ `runtime_config.SYSTEM_PROMPT`) |
| Identidad del agente (operador, nombre, branding) | Dashboard `/agent` o wizard `/setup` (→ `runtime_config`) |
| Aprovisionar Memory Stores + Agent + Kommo | Dashboard `/setup` (wizard idempotente) |
| Verticales (categorías de mensajes) | Dashboard `/verticales` (o `supabase/migrations/0002_seed.sql` antes del primer migrate) |
| Ruteo de leads al equipo (round robin / por término) | Ajustes → Agente → Acciones → "Ruteo de leads al equipo" + toggle por vertical en `/verticales` |
| Canales que se clasifican pero no se responden | Ajustes → Agente → Comportamiento → Canales → "Clasificar y rutear igual" |
| Prompts de graders | Dashboard `/outcomes` |
| Custom field y salesbot de Kommo | Dashboard `/settings` |
| Techo de gasto mensual | `/consumo` → "Techo de gasto mensual" (→ `runtime_config.MONTHLY_BUDGET_USD`; vacío = sin techo) |
| Modelo por componente | `/consumo` (→ `runtime_config.AGENT_MODEL` / `CLASSIFY_MODEL` / `COMMENT_REPLY_MODEL` / `GRADER_MODEL` / `DREAMS_MODEL`; default `claude-haiku-5-5`). El wizard `/setup` fija el del agente al crearlo |
| Secretos de arranque (irreducibles) | Host env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
