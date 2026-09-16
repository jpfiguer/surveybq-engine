-- =============================================================================
-- surveyBQ · esquema de destino en BigQuery
--
-- Una fila por respuesta. Las columnas planas replican la pestaña
-- Base_Analisis de CSAT_MAM_ordenado_v2.xlsx (en snake_case), para que la data
-- nueva se apile con la histórica de Qualtrics sin renombrar nada.
-- El detalle pregunta a pregunta viaja en `answers`, de modo que editar la
-- encuesta y agregar preguntas nuevas no obligue a migrar la tabla.
--
-- Reemplaza `proyecto.dataset` por los tuyos antes de ejecutar.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS `proyecto.experiencia_clientes`
OPTIONS (location = 'US');

CREATE TABLE IF NOT EXISTS `proyecto.experiencia_clientes.survey_responses`
(
  -- identidad ----------------------------------------------------------------
  response_id      STRING  NOT NULL OPTIONS (description = 'UUID único de la respuesta.'),
  survey_id        STRING  NOT NULL OPTIONS (description = 'demo-tipos | nps-relacional'),
  survey_version   STRING          OPTIONS (description = 'Versión de la definición usada al responder.'),
  survey_title     STRING,
  status           STRING          OPTIONS (description = 'completed | partial | disqualified'),

  -- contexto -----------------------------------------------------------------
  centro_comercial STRING          OPTIONS (description = 'Código del sitio o sucursal. Ej.: SITIO-01.'),
  touchpoint       STRING          OPTIONS (description = 'Punto de servicio evaluado. Solo CSAT.'),
  sector_contexto  STRING          OPTIONS (description = 'Ubicación específica dentro del sitio. Ej.: "Sector A", "Piso 2".'),

  -- indicador ----------------------------------------------------------------
  score_type       STRING          OPTIONS (description = 'CSAT | NPS'),
  score            INT64           OPTIONS (description = 'CSAT 1-5 o NPS 0-10.'),
  score_bucket     STRING          OPTIONS (description = 'Satisfecho/Neutro/Insatisfecho o Promotor/Pasivo/Detractor.'),
  csat_satisfecho  BOOL            OPTIONS (description = 'TRUE si CSAT >= 4. NULL en NPS. Base del % CSAT.'),

  -- drivers ------------------------------------------------------------------
  palanca            STRING        OPTIONS (description = 'Atributo elegido como más relevante. "Otro" si fue texto libre.'),
  palanca_otro       STRING        OPTIONS (description = 'Texto libre cuando la palanca fue "Otro".'),
  causa_raiz         ARRAY<STRING> OPTIONS (description = 'Sub-motivos marcados. Solo categorías; el texto libre va aparte.'),
  causa_raiz_otro    STRING,
  comentario_abierto STRING        OPTIONS (description = 'Verbatim del encuestado.'),

  -- perfil -------------------------------------------------------------------
  genero        STRING,
  rango_etario  STRING,

  -- tiempos ------------------------------------------------------------------
  fecha_inicio  TIMESTAMP NOT NULL,
  fecha_termino TIMESTAMP,
  fecha         DATE      OPTIONS (description = 'Fecha local de la visita.'),
  mes           STRING    OPTIONS (description = 'AAAA-MM, para cuadrar con el resumen mensual.'),
  dia_semana    STRING,
  horario       STRING    OPTIONS (description = 'Antes de 11:00 | 11:00 a 14:59 | 15:00 a 19:59 | 20:00 o más'),
  duracion_seg  INT64,
  progreso      INT64,
  finalizado    BOOL,

  -- detalle completo ---------------------------------------------------------
  answers ARRAY<STRUCT<
    page_id        STRING,
    question_id    STRING,
    question_title STRING,
    question_type  STRING,
    role           STRING,        -- score | driver | root_cause | verbatim | context | profile | screener
    value_text     STRING,        -- legible: resuelve "Otro" al texto escrito
    value_number   FLOAT64,
    -- codificado para agrupar: "Otro" queda como "Otro" y una matriz como
    -- ["limpieza=3", "rapidez=4"], que es lo que permite contar en SQL.
    values         ARRAY<STRING>,
    other_text     STRING
  >>,

  -- extras ------------------------------------------------------------------
  adjuntos         INT64  OPTIONS (description = 'Cantidad de archivos o firmas. El contenido NO se guarda acá.'),
  idioma_respuesta STRING OPTIONS (description = 'Idioma en que se respondió.'),
  puntaje          INT64  OPTIONS (description = 'Puntaje obtenido, si la encuesta puntúa.'),
  puntaje_maximo   INT64,

  -- origen -------------------------------------------------------------------
  canal        STRING OPTIONS (description = 'Etiqueta del QR o campaña: qr-sector-a, email, wsp.'),
  user_agent   STRING,
  idioma       STRING,
  ingested_at  TIMESTAMP
)
PARTITION BY fecha
CLUSTER BY survey_id, touchpoint, palanca
OPTIONS (
  description = 'Respuestas del motor surveyBQ. Cargar con bq load --source_format=NEWLINE_DELIMITED_JSON.',
  require_partition_filter = FALSE
);
