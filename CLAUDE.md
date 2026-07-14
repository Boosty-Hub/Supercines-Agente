# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

Template para construir un **agente conversacional sobre Kommo CRM** con clasificación (Haiku 4.5), respuesta vía Anthropic Managed Agent (Sonnet 4.6 + Memory Stores), aprendizaje automático nocturno (Dreams) y evaluación de calidad (Outcomes). Se customiza para cualquier operador **desde el dashboard** (`/setup` + `/agent`), sin tocar código.

Repo: `web/` (Next.js 14 dashboard + API routes) + `supabase/` (Postgres migrations + Edge Functions Deno) + `agent/` (template de system prompt).

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

No hay tests ni linter más allá de `eslint-config-next`. Verificación de cada cambio del front: `npx tsc --noEmit`. Para Edge Functions no hay typecheck local (Deno); validar desplegando y golpeando la función.

## Arquitectura — el pipeline (lo más importante)

Mensaje entra a Kommo → llega al sistema y fluye así, **todo desacoplado por la tabla `inbound_queue` + Edge Functions encadenadas**:

```
Kommo webhook ──> kommo-webhook ──> inbound_queue (pending)
                                          │ (waitUntil)
                                          ▼
                   process-inbound: parsea payload, upsert leads, inserta
                   messages, clasifica inbound con Haiku 4.5 (vertical +
                   intent/urgency/toxicity/requires_human_review)
                                          │ (waitUntil, modo cola sin message_id)
                                          ▼
                   generate-response: DEBOUNCE 45s por lead → batch de
                   TODOS los mensajes sin responder del lead → sesión CMA
                   (Sonnet 4.6) con Memory Stores montados → 1 draft
                                          │ (si approved)
                                          ▼
                   publish-to-kommo: PATCH custom field configurado +
                   corre salesbot → evaluate-outcomes (graders)
```

Resiliencia: `pg_cron` barre cada minuto `process-inbound`, `generate-response`, `publish-to-kommo` (migraciones 0006/0007/0013) por si el fire-and-forget se corta. `dreams-run` (daily/weekly) y `evaluate-outcomes`/`alerts-scan` (cada 5 min) también por cron.

### Invariantes críticos (romperlos rompe producción)

1. **`verify_jwt = false` para TODAS las Edge Functions.** Kommo postea sin JWT; con `verify_jwt=true` da 401 y nada entra. En deploys por CLI, está fijado en `supabase/config.toml` bajo `[functions.*]`. En deploys desde el browser (wizard `/first-run`), se fuerza vía la metadata del API call: `{ verify_jwt: false }` en cada llamada a `POST /v1/projects/{ref}/functions/deploy` (ver `web/src/lib/provision/management.ts`). **Nunca quitar ninguno de los dos mecanismos.**

2. **El trabajo lento del agente va dentro de `EdgeRuntime.waitUntil()`.** `generate-response` crea el draft `pending`, devuelve **202 de inmediato**, y corre el agente (~60-80s) en `waitUntil`. Si se hiciera antes de responder, el runtime mata la función al desconectarse el cliente (pg_net/fire-and-forget) → draft `pending` eterno. Mismo patrón en `kommo-webhook`→`process-inbound` y `process-inbound`→`generate-response`.

3. **Debounce + batching.** `process-inbound` dispara `generate-response` en **modo cola** (sin `message_id`) para que aplique el debounce. `generate-response` espera 45s de silencio desde el último inbound del lead y responde TODOS sus mensajes pendientes en UN solo draft (resuelve los "3 mensajes cortados = una idea"). `messages.answered_by_draft_id` marca todo el batch como cubierto (FK `on delete set null` → si el draft se borra por stale, se reprocesan). Drafts `pending` con `agent_metadata.generating=true` >8min se consideran runs muertos: un barrido global al inicio del modo cola los borra (el FK libera su batch para reprocesar). El umbral es holgado adrede — runs vivos con muchos tool calls llegan a ~2.5min, y borrar un run vivo solo duplica trabajo (las guardas `status='pending'` en delete/update evitan perder o duplicar respuestas).

4. **Tres switches en `kommo_publish_config` (singleton `is_active=true`):**
   - `agent_enabled` — kill switch; si `false` `generate-response` no genera nada.
   - `publishing_enabled` — si `false`, drafts se generan pero NO se publican (shadow/validación).
   - `bypass_review` — si `true` (y `publishing_enabled=true`), el agente responde y publica TODO aunque entre a review. No afecta el botón de revisión humana (forceReview siempre queda `pending`).
   - Combinación de validación inicial: `agent_enabled=true, publishing_enabled=false`.

5. **Migraciones con `${SUPABASE_URL}` placeholder.** Las migraciones que crean cron jobs (0006, 0007, 0009, 0010, 0011, 0013) usan `'${SUPABASE_URL}/functions/v1/<fn>'` en lugar de URLs hardcoded. La sustitución ocurre **en runtime** dentro de `web/src/app/api/provision/migrate/route.ts` antes de ejecutar cada SQL. El placeholder viaja intacto en los archivos `.sql` y en el archivo generado `migrations.generated.ts`. **No reemplazar el placeholder con la URL real en los archivos SQL** — dejá el placeholder para que el repo siga siendo reusable.

### Memoria y aprendizaje (Anthropic Managed Agents)

- Dos Memory Stores montados como filesystem en la sesión CMA. Sus nombres reales se configuran vía env vars (`MEMORY_STORE_MASTER_NAME` / `MEMORY_STORE_LEADS_NAME`):
  - **master** (read-only, global a todos los leads): `/voice/` (voz), `/kb/` (KB destilada), `/dreams/` (aprendizajes).
  - **leads** (read-write, por lead): `/<lead_id>/conversation.md` + `learnings.md`.
- En el código (web + edge) usamos los labels semánticos `"master"` y `"leads"` para no acoplar el schema a un nombre específico de store. El ID real viene de `ANTHROPIC_MEMORY_MASTER_ID` / `_LEADS_ID`.
- **Dreams**: `dreams-run` analiza conversaciones (24h/7d), Sonnet destila learnings y los escribe como `.md` en `<master>/dreams/`. El system prompt del agente obliga a leer `/dreams/` con **prioridad mayor que la voz base** antes de redactar. No es reentrenamiento: es retrieval en vivo. Cada learning lleva `severity` (sugerencia|advertencia|error, codificada también en el filename como `sug|adv|err`) y la política `runtime_config.DREAMS_AUTO_ACTIVATE` decide qué se activa solo: `all` (default), `error` (solo errores se auto-activan = autocorrección; el resto espera aprobación) o `none`. Lo no activado va a `/dreams-pending/` (el agente NO lo lee) y se aprueba/descarta desde `/dreams`. Todo dream `error` genera una alerta (`kind=dream_error`). El dashboard permite borrar activos (borra el archivo del Memory Store → el agente deja de adoptarlo).
- **Audio (notas de voz)**: si `respond_to_audio=true` y hay `OPENAI_API_KEY` en `runtime_config`, `process-inbound` transcribe con Whisper (`whisper-1`) y el texto sigue el pipeline normal (se guarda como `🎙️ <transcript>`). Sin key → `media_audio_no_key`; transcripción fallida → `requires_human_review`. La key se pide al activar el toggle en `/agent` → Filtros → Multimedia.
- `search_kb` es un custom tool del agente: embeddings gte-small 384d (`embed` function) + RPC `search_kb` (vector 0.7 + FTS español 0.3).
- Captura de mensajes salientes manuales de Kommo: **no resuelto**. El webhook `leads.add` no trae texto; los mensajes tecleados a mano viven en el sistema de chat de Kommo (amojo, credenciales aparte). Lo único recuperable vía API es lo que pasa por el custom field configurado (eventos `/api/v4/events`).

### System prompt del agente

El system prompt vivo está en `runtime_config.SYSTEM_PROMPT` (DB), editable desde el dashboard en `/agent`. Soporta placeholders que se sustituyen al sincronizar con Anthropic:
- `{{OPERATOR_NAME}}` — de `runtime_config.OPERATOR_NAME`.
- `{{MASTER_PATH}}` / `{{LEADS_PATH}}` — `/mnt/memory/<MEMORY_STORE_*_NAME>`.
- `{{MEMORY_STORE_MASTER}}` / `{{MEMORY_STORE_LEADS}}` — nombres de los stores.

La sustitución y la lista de tools viven en `web/src/lib/agent-prompt.ts` (compartidas por `/api/agent` y `/api/setup/agent`). Guardar en `/agent` llama `anthropic.beta.agents.update()` y persiste la versión nueva en `runtime_config.ANTHROPIC_AGENT_VERSION`. `agent/system-prompt.example.md` (commiteado) es el template de partida para copiar/pegar al wizard; el prompt vivo está en `runtime_config.SYSTEM_PROMPT`.

### Front (Next.js App Router)

- **Resilient boot**: el middleware (`src/middleware.ts` → `lib/supabase/middleware.ts`) detecta la ausencia de env vars de Supabase y redirige todo (excepto `/first-run/**`, `/api/provision/**`, `/_next/**`, `/favicon.ico`) al wizard de configuracion inicial. Nunca lanza un 500 aunque el entorno esté vacío.
- **`/first-run/` invariante**: ningún archivo bajo `web/src/app/first-run/` ni bajo `web/src/app/api/provision/` puede importar `@/lib/runtime-config` ni `@/lib/supabase/service` — ambos módulos lanzan si las vars de entorno no están presentes. Los componentes y routes de provision construyen sus clientes inline con `createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, ...)`.
- **Onboarding no bloqueante (setup drawer)**: el wizard de config del agente (Anthropic/Agent/Verticales/Memoria/Kommo) NO es una página full-screen — vive como panel lateral derecho montado en `(dashboard)/layout.tsx` (`setup-drawer.tsx`, client). El layout computa el estado server-side con `getSetupState()` (`lib/setup-state.ts`, DB-only) y lo monta **solo para admins fuera de embed**. El drawer se auto-abre 1x por sesión si falta config (guard en `sessionStorage`), ofrece un launcher flotante y respeta `?setup=open`. `/setup` es solo un `redirect("/inbox?setup=open")` — los links "corré /setup" dispersos siguen funcionando. Reusa las mismas rutas `/api/setup/*` que el wizard anterior.
- Single-user: usuario master se loguea; el `(dashboard)/layout.tsx` hace `getUser()` (hay 2 round-trips de auth por navegación — optimización pendiente conocida).
- Todas las páginas del dashboard son `export const dynamic = "force-dynamic"`. Hay `loading.tsx` (grupo + inbox) que dan feedback instantáneo vía Suspense.
- **Realtime**: `messages`/`drafts`/`leads`/`alerts` publicados (migración 0008/0011); componentes `realtime-refresher`/`realtime` hacen `router.refresh()` con debounce.
- Filtros Inbox/Leads: server-side por `searchParams`, componente compartido `(dashboard)/inbox/filters.tsx` (prop `collapsible` para el inbox). Inbox preserva los filtros en los links de conversación vía `filterQS`.
- RLS en todas las tablas: `authenticated` tiene acceso total (solo el master entra); `service_role` (Edge Functions) bypassea.
- Branding: el título del dashboard se resuelve **DB-first** (`runtime_config.NEXT_PUBLIC_AGENT_LABEL`, editable en `/agent`) en `(dashboard)/layout.tsx` y se pasa como prop al `nav` — NO depende del inlining build-time de `NEXT_PUBLIC_AGENT_LABEL`. Fallback al env var y, si no, default "Agente". El login sí usa el env var build-time.

## Convenciones y gotchas

- **`runtime_config` es la single source of truth** para credenciales e identidad por cliente (migración 0017/0018). Web y Edge leen DB-first/env-fallback; ya NO hace falta publicar secrets de Anthropic/Kommo vía Management API ni mantener los mismos valores en `web/.env.local` y en secrets de Supabase — el wizard `/first-run` + `/setup` los escribe una vez en DB. Lo único irreducible en el host como env vars: los 3 secretos de arranque de Supabase (URL, anon, service-role) que se necesitan para leer la DB. **Tradeoff de seguridad**: las credenciales en `runtime_config` están en texto plano, protegidas solo por RLS (acceso `authenticated` + `service_role`). Cifrado pgcrypto queda diferido a una iteración futura.
- Las nuevas keys de Supabase (`sb_publishable_*` / `sb_secret_*`) **no** funcionan con la REST API PostgREST (espera JWT de 3 partes). Para llamar la REST API usar las legacy JWT keys (`/v1/projects/<ref>/api-keys`).
- Edge Functions: Deno, imports por URL/`npm:`; el cron las invoca vía `net.http_post` (pg_net). Status `drafts`: `pending|approved|sent|rejected|auto_sent|failed`.
- Tras cambiar `web/.env.local` hay que **reiniciar** `pnpm dev` (Next lee env al arrancar). Cambiar secrets de Edge Functions NO requiere redeploy (se leen en runtime).
- UI en español, light theme. Sistema de diseño: tarjetas `rounded-xl border border-neutral-200 bg-white shadow-sm`, botón primario `bg-neutral-900 text-white rounded-lg`, badges `rounded-full text-[11px]`, tablas con `overflow-x-auto min-w-[640px]`, responsive a 375px (sidebar → drawer móvil en `(dashboard)/nav.tsx`).
- Migraciones: numeradas `00NN_nombre.sql`, idempotentes (`if not exists`), registradas en tabla `_migrations`. URLs absolutas usan `${SUPABASE_URL}` que sustituye el route handler de migrate en runtime.

## Customización por proyecto

| Cosa | Dónde |
|---|---|
| Voz / system prompt del operador | Dashboard `/agent` (→ `runtime_config.SYSTEM_PROMPT`) |
| Identidad del agente (operador, nombre, branding) | Dashboard `/agent` o wizard `/setup` (→ `runtime_config`) |
| Aprovisionar Memory Stores + Agent + Kommo | Dashboard `/setup` (wizard idempotente) |
| Verticales (categorías de mensajes) | Dashboard `/verticales` (o `supabase/migrations/0002_seed.sql` antes del primer migrate) |
| Prompts de graders | Dashboard `/outcomes` |
| Custom field y salesbot de Kommo | Dashboard `/settings` |
| Modelo (Sonnet vs otro) | Wizard `/setup` (→ `runtime_config.AGENT_MODEL`, default `claude-sonnet-4-6`) |
| Secretos de arranque (irreducibles) | Host env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |
