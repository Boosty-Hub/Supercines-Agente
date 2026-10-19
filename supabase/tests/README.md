# Tests SQL de `supabase/`

> **Atajo:** `npm run verify:sql` (también parte de `npm run verify`) levanta un Postgres de
> Supabase efímero, aplica TODAS las migraciones como `postgres` —el rol real del Management API,
> dos veces las 0060+— y corre TODOS los tests de esta carpeta con `psql -f` como `supabase_admin`.
> Falla si un test sale con error o no imprime ningún `ok:`. Sin docker falla, salvo
> `SKIP_SQL_TESTS=1` (avisa en grande). Los pasos manuales de abajo hacen lo mismo a mano.

Cada `*.sql` de esta carpeta prueba migraciones contra un Postgres **real** (RLS, privilegios,
funciones SECURITY DEFINER, carreras). Corre dentro de una transacción que termina en
`rollback`, así que no deja datos, pero **nunca** se corre contra un proyecto de un cliente:
solo contra una base desechable.

Los `*.test.ts` de esta carpeta son de Deno y corren con `npm run test` en la raíz.

## Requisitos

- La imagen de Postgres de Supabase (trae los roles `anon`, `authenticated`, `service_role`,
  el esquema `auth` y las extensiones): `public.ecr.aws/supabase/postgres:17.11.0.004`.
- Aplicar las migraciones como **`postgres`** (el rol con el que las corre el Management API en
  producción; los default privileges y los permisos que importan son los de ese rol) y correr los
  tests como **superusuario** (`supabase_admin`): los tests cambian de rol con
  `set local role`, crean usuarios en `auth.users` y vuelven a ejecutar migraciones.
- `psql -f <archivo>` desde un árbol donde `migrations/` esté **al lado** de `tests/`: algunos
  tests hacen `\ir ../migrations/00NN_….sql` (relativo al archivo). Por stdin (`psql < x.sql`)
  esa ruta no se resuelve.

## Pasos

```bash
# 1. Base desechable (nombre y puerto propios)
docker run -d --name sql-tests -e POSTGRES_PASSWORD=postgres -p 61210:5432 \
  public.ecr.aws/supabase/postgres:17.11.0.004
# esperar a que acepte conexiones
until docker exec sql-tests pg_isready -U postgres -h localhost; do sleep 1; done

# 2. Copiar supabase/ entero (migrations/ + tests/) al contenedor
docker cp supabase sql-tests:/tmp/supabase

# 3. Aplicar TODAS las migraciones en orden léxico, sustituyendo el placeholder
#    ${SUPABASE_URL} como hace el runner del panel. Una segunda pasada de las 0060+
#    prueba que son idempotentes (las anteriores no son re-ejecutables y el runner
#    nunca las repite).
aplicar() {
  sed 's#${SUPABASE_URL}#http://localhost:54321#g' "supabase/migrations/$1" |
    docker exec -i sql-tests psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -q
}
for f in $(ls supabase/migrations | sort); do aplicar "$f" || break; done
for f in $(ls supabase/migrations | sort | awk '$0 >= "0060"'); do aplicar "$f" || break; done

# 4. Correr cada test (falla = un `ERROR` con «FALLO: <qué>»; cada «ok: …» es una verificación)
for t in supabase/tests/*.sql; do
  docker exec sql-tests psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
    -f "/tmp/supabase/tests/$(basename "$t")"
done

# 5. Borrar la base
docker rm -f sql-tests
```

## Qué cubre cada uno

| Test | Migraciones | Qué impone |
|---|---|---|
| `function_execute.sql` | 0063, 0070, 0072 | Ninguna función propia ejecutable por anon/PUBLIC; authenticated solo las del panel; SECURITY DEFINER con `search_path` fijo y guard |
| `rls_coverage.sql` | 0079 | RLS en toda tabla, vistas security_invoker, matriz de privilegios de `authenticated` por tabla, default privileges cerrados |
| `rls_initplan.sql` | 0084 | Ninguna policy de public lee el JWT (`request.jwt.claims`, `auth.uid()`/`jwt()`/`role()`) fuera de una subconsulta escalar `(select …)`: inline se evalúa por fila; el `explain` de `leads` usa un InitPlan |
| `runtime_config_lockdown.sql` | 0079 | La matriz tabla × alcance (incluye «sin rol ve 0 filas en todo», drafts/messages por columna, «a nombre propio») |
| `agent_tools_scope.sql` | 0078 | `agent_tools` solo alcance configuracion |
| `scope_backfill.sql` | 0078 | Backfill del rol: solo el MAESTRO sin rol queda en configuracion; el resto y los nuevos sin rol no ven nada |
| `revoke_user_sessions.sql` | 0082 | Corte de sesiones de un usuario, solo service_role |
| `claim_kommo_backfill.sql`, `kommo_webhook_auth.sql` | 0061, 0073, 0090 | Recorrido de Kommo, verificación de borrados con el recorrido terminado y autenticidad del webhook |
| `draft_publish_claim.sql`, `follow_up_claim.sql` | 0074, 0075, 0077 | Reservas de envío (a lo sumo un envío) |
| `alert_webhook_sweep.sql` | 0076 | Barrido del webhook de alertas (prioridad por severidad, agregación, dedupe) |
| `provisioned_marker.sql` | 0083 | Marcador `PROVISIONED_AT`: una instalación con usuarios queda sellada |
| `supercines_table_scopes.sql` | 0080, 0081 | Tablas propias de SuperCines (`routing_*`, `lead_routing_events`, `salesbot_funnel_leads`) fail-closed; la config real de alertas llega a los 17 tipos |
| `internal_gate.sql` | 0061, 0069 | `x-internal-secret` en el cron; nada abierto a anon |
| `funnel_positions.sql`, `claim_message_batch.sql`, `system_incidents.sql` | 0062, 0064, 0071 | Embudos de Salesbots, reserva de lotes, incidentes de salud |

**Tabla nueva** → RLS, grants explícitos (nace sin privilegios para anon/authenticated) y
sumarla a la matriz de `rls_coverage.sql` (y de CLAUDE.md «Quién entra y hasta dónde»).
**Función nueva** → ver la lista de `function_execute.sql`.
