#!/usr/bin/env bash
#
# surveyBQ — da de alta un cliente nuevo.
#
#   ./tools/nuevo_cliente.sh <cliente> <encuesta-id> "<Título>"
#
# Ejemplo:
#   ./tools/nuevo_cliente.sh acme acme-satisfaccion "Satisfacción de clientes"
#
# Hace de una todo lo que antes eran siete pasos sueltos, que era justamente el
# problema: olvidar uno dejaba al cliente a medio configurar y sus respuestas
# rechazadas.
#
#   1. dataset propio en BigQuery, con sus tablas
#   2. archivo de encuesta a partir de una plantilla
#   3. registro de la encuesta en las páginas
#   4. mapa encuesta -> dataset actualizado en las tres funciones
#
# Es idempotente: se puede volver a correr.

set -euo pipefail

CLIENTE="${1:-}"; ENCUESTA="${2:-}"; TITULO="${3:-}"
PROYECTO="${SBQ_PROYECTO:-surveybq}"
REGION="${SBQ_REGION:-southamerica-west1}"
BASE_URL="${SBQ_BASE_URL:-https://TU-DESPLIEGUE.example.com}"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "$CLIENTE" || -z "$ENCUESTA" || -z "$TITULO" ]]; then
  echo "Uso:  ./tools/nuevo_cliente.sh <cliente> <encuesta-id> \"<Título>\"" >&2
  echo "Ej.:  ./tools/nuevo_cliente.sh acme acme-satisfaccion \"Satisfacción de clientes\"" >&2
  exit 1
fi
# El cliente es un nombre de dataset y la encuesta va en una URL: nada raro.
[[ "$CLIENTE"  =~ ^[a-z][a-z0-9_]{1,60}$ ]] || { echo "Cliente inválido: minúsculas, números y _ (empieza por letra)." >&2; exit 1; }
[[ "$ENCUESTA" =~ ^[a-z][a-z0-9-]{1,60}$ ]] || { echo "Encuesta inválida: minúsculas, números y - (empieza por letra)." >&2; exit 1; }

echo "▸ Cliente: $CLIENTE · encuesta: $ENCUESTA · proyecto: $PROYECTO"

# --------------------------------------------------------------- 1. BigQuery
if bq show --format=none "${PROYECTO}:${CLIENTE}" >/dev/null 2>&1; then
  echo "  dataset ya existe"
else
  bq --location="$REGION" mk -d --description "Experiencia de clientes · ${CLIENTE}" \
     "${PROYECTO}:${CLIENTE}" >/dev/null
  echo "  dataset creado"
fi
for SQL in 01_esquema 04_definiciones; do
  sed -n '/^CREATE TABLE/,$p' "$RAIZ/bigquery/${SQL}.sql" \
    | sed "s/proyecto\.experiencia_clientes/${PROYECTO}.${CLIENTE}/g" \
    | bq query --use_legacy_sql=false --project_id="$PROYECTO" >/dev/null
done
echo "  tablas listas"

# --------------------------------------------------------------- 2. encuesta
ARCHIVO="$RAIZ/surveys/${ENCUESTA}.js"
if [[ -f "$ARCHIVO" ]]; then
  echo "  la encuesta ya existe, no se toca"
else
  cat > "$ARCHIVO" <<PLANTILLA
/*!
 * surveyBQ — ${TITULO}
 *
 * Esqueleto inicial. Se termina de armar en el editor web:
 *   ${BASE_URL}/editor?survey=${ENCUESTA}
 */
SBQ.registerSurvey({
  id: '${ENCUESTA}',
  version: '1.0.0',
  title: '${TITULO}',
  locale: 'es-CL',

  variables: { empresa: '${CLIENTE}', periodo: 'este mes' },
  theme: { accent: '#b4124f', radius: '16px' },

  pages: [
    {
      title: 'Cuéntanos cómo te fue',
      elements: [
        {
          id: 'nps',
          type: 'rating',
          role: 'score',
          scoreType: 'nps',
          title: '¿Qué tan probable es que recomiendes {empresa} a un colega o conocido?',
          rateMin: 0,
          rateMax: 10,
          minRateDescription: 'Nada probable',
          maxRateDescription: 'Muy probable',
          required: true
        },
        {
          id: 'comentario_abierto',
          type: 'comment',
          role: 'verbatim',
          title: '¿Qué podríamos mejorar?',
          placeholder: 'Escribe aquí (opcional)',
          maxLength: 1500
        }
      ]
    }
  ],

  completedHtml: '<h2>Gracias por responder</h2><p>Tu respuesta llega directo al equipo.</p>'
});
PLANTILLA
  echo "  encuesta creada desde la plantilla"
fi

# ------------------------------------------------- 3. registro en las páginas
for HTML in responder.html index.html editor.html panel.html imprimir.html; do
  RUTA="$RAIZ/$HTML"
  if ! grep -q "surveys/${ENCUESTA}.js" "$RUTA"; then
    python3 - "$RUTA" "$ENCUESTA" <<'PY'
import io, sys
ruta, enc = sys.argv[1], sys.argv[2]
s = io.open(ruta, encoding='utf-8').read()
ancla = '<script src="surveys/nps-relacional.js"></script>'
s = s.replace(ancla, ancla + '\n<script src="surveys/%s.js"></script>' % enc, 1)
io.open(ruta, 'w', encoding='utf-8').write(s)
PY
  fi
done
echo "  registrada en las páginas"

# ----------------------------------------------------- 4. registro del cliente
# Una fila en config.clientes y listo. Antes esto obligaba a redesplegar las
# tres funciones —seis a ocho minutos, y si una quedaba sin actualizar el
# cliente funcionaba a medias—; ahora las funciones lo leen de la tabla.
YA="$(bq query --use_legacy_sql=false --format=csv --project_id="$PROYECTO" \
      "SELECT COUNT(*) FROM \`${PROYECTO}.config.clientes\` WHERE survey_id='${ENCUESTA}'" \
      2>/dev/null | tail -1)"
if [[ "${YA:-0}" -gt 0 ]]; then
  echo "  la encuesta ya estaba registrada"
else
  bq query --use_legacy_sql=false --project_id="$PROYECTO" \
    "INSERT INTO \`${PROYECTO}.config.clientes\`
       (survey_id, dataset, cliente, activo, creado_en, notas)
     VALUES ('${ENCUESTA}', '${CLIENTE}', '${TITULO}', TRUE, CURRENT_TIMESTAMP(), NULL)" >/dev/null
  echo "  registrado en config.clientes"
fi

# Las funciones guardan el mapa en memoria un minuto, así que un alta recién
# hecha puede tardar ese rato en aceptar respuestas.
echo "  (las funciones lo toman en menos de un minuto)"

echo
echo "✓ Cliente $CLIENTE dado de alta."
echo "  Encuesta:  ${BASE_URL}/responder?survey=${ENCUESTA}"
echo "  Editarla:  ${BASE_URL}/editor?survey=${ENCUESTA}"
echo "  Datos:     ${PROYECTO}.${CLIENTE}.survey_responses"
echo
echo "  Falta subir el registro de la encuesta para que salga a la web:"
echo "     git add -A && git commit -m 'Alta de ${CLIENTE}' && git push && vercel deploy --prod --yes"
