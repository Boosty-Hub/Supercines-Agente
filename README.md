# Template-Agent-kommo

Template para construir un agente conversacional sobre **Kommo CRM + Claude Sonnet (Anthropic Managed Agents) + Supabase**. Da out-of-the-box: clasificación de mensajes (Haiku), respuesta con voz custom (Sonnet + Memory Stores), debounce/batching, aprendizajes automáticos nocturnos (Dreams), evaluación de calidad (Outcomes), y panel de revisión humana.

## Regla #1 — Nunca edites este repo

Este repo es **la plantilla**. Cada agente nuevo arranca creando **un repo propio** a partir de este template. Después trabajás en ese repo nuevo, nunca acá.

```bash
# gh CLI
gh repo create <tu-org>/<nombre-agente> \
  --template Boosty-Hub/Template-Agent-kommo \
  --private --clone
cd <nombre-agente>

# o desde github.com: botón "Use this template" → "Create a new repository"
```

---

## Desplegar un cliente nuevo — flujo zero-CLI

No hay `pnpm bootstrap`. Todo sucede desde el navegador.

### Paso 1 — Crear la infraestructura externa (manual, una vez)

| Qué | Dónde |
|-----|-------|
| Proyecto Supabase | supabase.com → New project |
| API key de Anthropic | console.anthropic.com/settings/keys |
| Integración privada en Kommo | Settings → Integrations → tipo Private → scope `crm` |

### Paso 2 — Deployar el dashboard en tu host

Deployá el repo en Netlify o Vercel. El proyecto Next.js vive en `web/`.

| Host | Config mínima |
|------|---------------|
| Netlify | Base directory: `web/` (ya en `netlify.toml`) |
| Vercel | Root directory: `web/` |

**Constraint de build**: el directorio `web/` necesita acceso a `../supabase/` para correr el codegen (`predev`/`prebuild`). Asegurate de que el host clone el repo completo (no solo `web/`). Netlify y Vercel hacen checkout completo por defecto — no necesitás nada extra.

### Paso 3 — Configurar las 3 variables de entorno en el host

Antes del primer redeploy, configurá estas variables en tu host (Site Settings en Netlify, o Project Settings en Vercel):

| Variable | Dónde obtenerla |
|----------|-----------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Mismo lugar → Legacy API keys → `anon (public)` |
| `SUPABASE_SERVICE_ROLE_KEY` | Mismo lugar → Legacy API keys → `service_role (secret)` |

> Las claves legacy JWT (que empiezan con `eyJ...`) son las que funcionan con PostgREST. NO uses las nuevas `sb_publishable_*` para este caso.

Luego redesploya el sitio. Abrí la URL desplegada — el wizard de configuracion inicial arranca automáticamente.

### Paso 4 — Wizard de configuracion inicial (`/first-run`)

El wizard te guia por tres pasos:

1. **Conectar** — instrucciones para configurar las variables (ya las configuraste en el paso 3). El wizard detecta la conexión automáticamente y avanza.
2. **Inicializar** — pegás tu Personal Access Token de Supabase (`sbp_...`, de `supabase.com/dashboard/account/tokens`) y el wizard aplica todas las migraciones SQL y deploya las Edge Functions en tu proyecto. Todo con barra de progreso por unidad.
3. **Crear usuario** — email + contraseña para el único usuario del dashboard. El sistema bloquea registros adicionales automáticamente.

Tras crear el usuario, el wizard te lleva directo al dashboard (`/inbox`). El onboarding de Anthropic + Kommo **NO es obligatorio para entrar**: continúa como un panel lateral (drawer) que se abre solo la primera vez.

### Paso 5 — Wizard de provisioning Anthropic + Kommo (panel lateral)

Ya dentro del dashboard, un **panel lateral derecho** ("Configurá tu agente") te guía paso a paso. No bloquea: podés cerrarlo y usar la plataforma, y reabrirlo cuando quieras desde el botón flotante abajo a la derecha (o visitando `/setup`, que lo abre). El progreso se muestra en una barra (N de 5) y podés retomar desde donde lo dejaste. Provisiona:

1. Credenciales de Anthropic + identidad del agente.
2. Managed Agent con el system prompt.
3. Verticales (opcional — la IA sugiere categorías de mensaje).
4. Memory Stores (master + leads).
5. Conexión Kommo (token long-lived, subdominio, dominio API).

Todo se guarda en `runtime_config` (la base de datos), no en variables de entorno. Idempotente — podés re-correrlo sin duplicar nada.

### Paso 6 — Configurar Kommo (en el panel de Kommo)

- Webhook URL: `https://<ref>.supabase.co/functions/v1/kommo-webhook`
- Eventos: Mensaje agregado, Lead agregado, Lead actualizado
- En `/settings` del dashboard: `response_custom_field_id` + `salesbot_id`

### Paso 7 — Activar el agente

En `/settings`: `agent_enabled = true`, `publishing_enabled = false` (shadow al principio). Cuando confirmes calidad: `publishing_enabled = true`.

---

## Actualizar un cliente ya desplegado

Cuando publicás código nuevo (un fix, una migración, una Edge Function), el **dashboard** (Netlify/Vercel) se redespliega solo con el `git push`. Pero la **base de datos** (migraciones) y las **Edge Functions** viven en el Supabase del cliente y **NO** se actualizan con el deploy del front — hay que **sincronizarlas**. Eso se hace desde el navegador, sin CLI ni tocar Supabase a mano.

> El front auto-deploya; la DB y las funciones, no. Esta función cierra esa brecha.

### Aviso automático en el header

Apenas el cliente abre el dashboard después de un deploy nuevo, una **barra arriba de todas las páginas** detecta el drift (compara el código embebido contra lo que hay aplicado en Supabase):

- **Auto-update ON** (por defecto): aplica las migraciones y redespliega las funciones **solo**, una vez por sesión, mostrando el progreso en la barra (`Actualizando el sistema…` → `✓ Sistema actualizado correctamente`).
- **Auto-update OFF**: la barra muestra **`Hay N actualizaciones disponibles · Actualizar ahora`**. Hacés click y se aplican. Podés cerrar el aviso (✕) por sesión.

El aviso usa el token `sbp_...` ya guardado en la base (el del wizard `/first-run`); si no hay token guardado, no aparece (se controla desde el panel de abajo).

### Control manual — `/settings` → tab **Sistema**

Panel **"Actualizaciones del sistema"**:

1. **Buscar** — re-chequea el estado. Muestra `✓ Todo al día — 40/40 migraciones, 9 funciones desplegadas`, o `Hay actualizaciones disponibles` con la lista: migraciones nuevas + funciones marcadas `nueva` (no desplegada) o `cambió` (hash distinto al desplegado).
2. **Actualizar todo** — aplica las migraciones (una por una) y redespliega las funciones faltantes/cambiadas, siempre con `verify_jwt=false`. Muestra progreso por unidad. Idempotente: re-aplicar no duplica nada.
3. **Token** — si nunca lo guardaste, el panel pide el Personal Access Token de Supabase (`sbp_...`). Tras la primera vez queda en `runtime_config` y no lo vuelve a pedir.
4. **Actualización automática** — toggle para prender/apagar el auto-update del header.

> **Cómo detecta el drift**: migraciones = array `MIGRATIONS` embebido por el codegen vs la tabla `_migrations` (aplicadas); funciones = hash del bundle de cada función vs `runtime_config.DEPLOYED_FUNCTION_HASHES` + presencia real en Supabase.
>
> Como `_shared/*` se bundlea en **todas** las funciones, un cambio en un archivo compartido marca las 9 como `cambió` y se redespliegan todas — es esperado y seguro (las que no usan ese archivo quedan idénticas).

### Tabs de `/settings` (título: **Configuración**)

| Tab | Qué hay |
|-----|---------|
| **Conexiones** | URL del webhook de Kommo (para copiar al panel de Kommo) + conectar Shopify (opcional). |
| **Publicación** | Estado actual (agente, publicación/validación, bypass review, Field ID, Salesbot ID) + form de Publicación Kommo (campo destino donde escribe el agente, salesbot, modo de respuesta). |
| **Sistema** | Actualizaciones del sistema (lo de arriba) + Alertas (webhook Slack/Discord/Zapier). |
| **Integrar** | Snippet para embeber el dashboard dentro de otra app. |

---

## Desarrollo local

```bash
# Desde web/ — requiere web/.env.local con las 3 vars de Supabase
cd web
pnpm install
pnpm dev           # arranca en :3000; corre codegen automáticamente

# Typecheck (no hay test suite)
npx tsc --noEmit

# Re-deploy de una Edge Function puntual
SUPABASE_ACCESS_TOKEN=<token> \
  npx supabase functions deploy <fn> --project-ref <ref>
```

Para desarrollo local necesitás `web/.env.local`. Copiá desde `web/.env.example`:

```bash
cp web/.env.example web/.env.local
# Completá NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

---

## Stack

- **Next.js 14** (App Router, TS, Tailwind) — dashboard + Route Handlers
- **Supabase** — Postgres 17 + pgvector + Auth + Realtime + Edge Functions (Deno 2)
- **Anthropic** — Haiku 4.5 (clasificación), Sonnet 4.6 (CMA), Memory Stores
- **Kommo CRM** — webhook entrante, REST v4, Salesbot v2

## Qué customizar por cliente

| Qué | Dónde |
|-----|-------|
| Voz / system prompt | Dashboard `/agent` → sincroniza con Anthropic al guardar |
| Identidad del agente y branding | Dashboard `/agent` o wizard `/setup` |
| Provisioning Anthropic + Kommo | Dashboard `/setup` (idempotente) |
| Verticales (categorías de mensajes) | Dashboard `/verticales` |
| Prompts de graders | Dashboard `/outcomes` |
| Switches operativos | Dashboard `/settings` |
| Variables irreducibles de Supabase | Host env vars (las 3 de arriba) |

## Estructura

```
.
├── SETUP-WITH-CLAUDE.md           # playbook para setup asistido por Claude
├── agent/
│   ├── system-prompt.example.md  # template del system prompt
│   └── from-n8n.md               # guía para importar un workflow n8n
├── supabase/
│   ├── migrations/               # SQL idempotentes; cron URLs usan ${SUPABASE_URL}
│   ├── functions/                # Edge Functions Deno con verify_jwt=false
│   └── config.toml
├── web/                          # Next.js 14 dashboard
│   └── scripts/
│       └── embed-provision.mjs  # codegen: embebe migrations + functions en TS
├── .env.example                  # referencia de vars (raíz — solo para dev local)
├── web/.env.example              # vars del front (las 3 obligatorias)
├── netlify.toml
├── CLAUDE.md                     # arquitectura + invariantes críticos
└── README.md
```

## Documentación

- **`CLAUDE.md`** — arquitectura del pipeline, invariantes críticos (`verify_jwt`, `waitUntil`, debounce, switches). Leer antes de tocar Edge Functions.
- **`SETUP-WITH-CLAUDE.md`** — playbook paso a paso para setup asistido por Claude Code.
