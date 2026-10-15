#!/usr/bin/env bash
# Verificación SQL: aplica TODAS las migraciones (dos veces las 0060+, para probar que son
# idempotentes) a un Postgres de Supabase EFÍMERO y corre TODOS los supabase/tests/*.sql.
#
#  · Las migraciones se aplican como `postgres`: es el rol REAL con el que el Management API
#    (el actualizador del panel) las ejecuta en producción. Aplicarlas como supabase_admin
#    (superusuario) escondería permisos que `postgres` no tiene.
#  · Los tests corren como `supabase_admin` (superusuario: cambian de rol, crean usuarios,
#    re-ejecutan migraciones con \ir) con `psql -f` desde un árbol donde migrations/ está al
#    lado de tests/ (ver supabase/tests/README.md).
#  · Un test roto NO puede pasar desapercibido: se mira el código de salida de psql (ON_ERROR_STOP)
#    y además cada archivo debe imprimir al menos un `ok:`.
#  · Sin docker falla, salvo SKIP_SQL_TESTS=1 (se avisa en grande: solo para máquinas sin docker).
set -uo pipefail
cd "$(dirname "$0")/.."

NAME="${SQL_TEST_CONTAINER:-verify-sql-pg}"
IMAGE="${SQL_TEST_IMAGE:-public.ecr.aws/supabase/postgres:17.11.0.004}"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  if [ "${SKIP_SQL_TESTS:-}" = "1" ]; then
    echo "################################################################"
    echo "# AVISO: docker no está disponible y SKIP_SQL_TESTS=1: los tests  #"
    echo "# SQL (RLS, privilegios, migraciones) NO se corrieron.            #"
    echo "################################################################"
    exit 0
  fi
  echo "verify:sql necesita docker (Postgres efímero de Supabase). Instalalo o, solo en una máquina sin docker, exportá SKIP_SQL_TESTS=1 (se avisa)." >&2
  exit 1
fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null || { echo "no se pudo levantar $IMAGE" >&2; exit 1; }

for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break
  sleep 1
done
sleep 4 # el entrypoint de la imagen reinicia el servidor tras inicializar roles
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -h localhost >/dev/null 2>&1 && break
  sleep 1
done

docker cp supabase "$NAME:/tmp/supabase" >/dev/null || { echo "docker cp falló" >&2; exit 1; }

run_sql() { # $1 = usuario ; stdin = SQL
  docker exec -i "$NAME" psql -U "$1" -d postgres -v ON_ERROR_STOP=1 -q
}

docker exec -i "$NAME" psql -U postgres -d postgres -q -c \
  "create table if not exists _migrations (filename text primary key, applied_at timestamptz default now());" >/dev/null

apply_pass() { # $1 = pasada
  local f base n out
  for f in $(ls supabase/migrations/*.sql | sort); do
    base=$(basename "$f")
    n=$((10#${base%%_*}))
    # Segunda pasada: solo las 0060+ (las anteriores no son re-ejecutables y el runner nunca las repite).
    if [ "$1" = "2" ] && [ "$n" -lt 60 ]; then continue; fi
    if ! out=$(sed 's#${SUPABASE_URL}#http://localhost:54321#g' "$f" | run_sql postgres 2>&1); then
      echo "FALLA la migración $base (pasada $1, como postgres):" >&2
      echo "$out" | grep -v NOTICE | head -12 >&2
      exit 1
    fi
  done
  echo "migraciones: pasada $1 OK (como postgres)"
}
apply_pass 1
apply_pass 2

failed=0
total=0
for t in supabase/tests/*.sql; do
  name=$(basename "$t")
  out=$(docker exec "$NAME" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f "/tmp/supabase/tests/$name" 2>&1)
  code=$?
  oks=$(printf '%s\n' "$out" | grep -c 'NOTICE:  ok:')
  if [ $code -ne 0 ] || [ "$oks" -lt 1 ]; then
    echo "== $name: FALLA (exit $code, $oks verificaciones ok)" >&2
    printf "%s\n" "$out" | grep -E "ERROR|FALLO|CONTEXT|DETAIL|HINT" | head -15 >&2
    failed=1
  else
    echo "== $name: OK ($oks verificaciones)"
  fi
  total=$((total + 1))
done
[ "$total" -ge 1 ] || { echo "no se encontró ningún test en supabase/tests/*.sql" >&2; exit 1; }
if [ $failed -ne 0 ]; then echo "verify:sql: HAY TESTS SQL ROTOS" >&2; exit 1; fi
echo "verify:sql OK ($total archivos)"
