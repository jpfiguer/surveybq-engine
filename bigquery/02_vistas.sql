-- =============================================================================
-- surveyBQ · vistas de análisis
-- Reproducen los cortes de la pestaña Resumen_CSAT y dejan la data lista para
-- cruzarse con la auditoría de Bequarks.
-- =============================================================================

-- 1) % CSAT, promedio y N por touchpoint y mes -------------------------------
--    Equivale a las tres tablas de la pestaña Resumen_CSAT.
CREATE OR REPLACE VIEW `proyecto.experiencia_clientes.v_csat_resumen` AS
SELECT
  centro_comercial,
  touchpoint,
  mes,
  COUNT(*)                                        AS n_respuestas,
  ROUND(AVG(score), 2)                            AS csat_promedio,
  ROUND(COUNTIF(csat_satisfecho) / COUNT(*), 4)   AS pct_csat,
  COUNTIF(score <= 2)                             AS n_insatisfechos,
  ROUND(COUNTIF(score <= 2) / COUNT(*), 4)        AS pct_insatisfecho
FROM `proyecto.experiencia_clientes.survey_responses`
WHERE survey_id = 'demo-tipos'
  AND status = 'completed'
  AND score IS NOT NULL
GROUP BY centro_comercial, touchpoint, mes;


-- 2) NPS por mes --------------------------------------------------------------
CREATE OR REPLACE VIEW `proyecto.experiencia_clientes.v_nps_resumen` AS
SELECT
  centro_comercial,
  mes,
  COUNT(*)                                    AS n_respuestas,
  COUNTIF(score_bucket = 'Promotor')          AS promotores,
  COUNTIF(score_bucket = 'Pasivo')            AS pasivos,
  COUNTIF(score_bucket = 'Detractor')         AS detractores,
  ROUND(100 * (COUNTIF(score_bucket = 'Promotor') - COUNTIF(score_bucket = 'Detractor'))
        / COUNT(*), 1)                        AS nps
FROM `proyecto.experiencia_clientes.survey_responses`
WHERE survey_id = 'nps-relacional'
  AND status = 'completed'
  AND score IS NOT NULL
GROUP BY centro_comercial, mes;


-- 3) Formato largo: una fila por respuesta y causa raíz -----------------------
--    Es la vista sobre la que se hace el cruce con la auditoría.
CREATE OR REPLACE VIEW `proyecto.experiencia_clientes.v_causas_largo` AS
SELECT
  r.response_id,
  r.survey_id,
  r.centro_comercial,
  r.touchpoint,
  r.sector_contexto,
  r.fecha,
  r.mes,
  r.score,
  r.score_bucket,
  r.csat_satisfecho,
  r.palanca,
  causa,
  r.comentario_abierto,
  r.canal
FROM `proyecto.experiencia_clientes.survey_responses` AS r,
     UNNEST(IF(ARRAY_LENGTH(r.causa_raiz) = 0, [CAST(NULL AS STRING)], r.causa_raiz)) AS causa
WHERE r.status = 'completed';


-- 4) Ranking de palancas por touchpoint --------------------------------------
--    Responde "¿qué mueve la nota en cada punto de servicio?".
CREATE OR REPLACE VIEW `proyecto.experiencia_clientes.v_palancas_ranking` AS
SELECT
  centro_comercial,
  touchpoint,
  palanca,
  COUNT(*)                                                AS menciones,
  ROUND(AVG(score), 2)                                    AS csat_promedio,
  ROUND(COUNTIF(csat_satisfecho) / COUNT(*), 4)           AS pct_csat,
  -- Brecha contra el promedio del touchpoint: cuánto arrastra esta palanca.
  ROUND(AVG(score) - AVG(AVG(score)) OVER (PARTITION BY centro_comercial, touchpoint), 2)
                                                          AS brecha_vs_touchpoint
FROM `proyecto.experiencia_clientes.survey_responses`
WHERE survey_id = 'demo-tipos'
  AND status = 'completed'
  AND palanca IS NOT NULL
GROUP BY centro_comercial, touchpoint, palanca;


-- 5) Detalle plano pregunta a pregunta ----------------------------------------
--    Sirve para revisar respuestas de preguntas nuevas que aún no tienen
--    columna propia (todo lo que se agregue desde el editor cae aquí).
CREATE OR REPLACE VIEW `proyecto.experiencia_clientes.v_respuestas_detalle` AS
SELECT
  r.response_id,
  r.survey_id,
  r.centro_comercial,
  r.touchpoint,
  r.fecha,
  r.mes,
  a.page_id,
  a.question_id,
  a.question_title,
  a.question_type,
  a.role,
  a.value_text,
  a.value_number,
  a.other_text
FROM `proyecto.experiencia_clientes.survey_responses` AS r,
     UNNEST(r.answers) AS a;


-- 6) Rendimiento de cada QR --------------------------------------------------
--    En estacionamientos hay un código por punto físico (máquina de pago,
--    cajero manual, acceso peatonal, salida vehicular). Todos guardan el mismo
--    sector: lo que cambia es la etiqueta `canal`, y con eso se compara qué
--    ubicación produce respuestas y cuál no vale la pena reponer.
--
--    OJO al leerlo: no está normalizado por flujo de gente. Un punto con más
--    tránsito recibe más respuestas aunque el adhesivo funcione peor. Sirve
--    para ordenar por magnitud y para detectar los que están en cero, no como
--    medida limpia de efectividad.
CREATE OR REPLACE VIEW `proyecto.experiencia_clientes.v_qr_rendimiento` AS
SELECT
  centro_comercial,
  touchpoint,
  canal,
  sector_contexto,
  mes,
  COUNT(*)                                                      AS respuestas,
  COUNTIF(status = 'completed')                                 AS completadas,
  COUNTIF(status = 'partial')                                   AS abandonadas,
  ROUND(COUNTIF(status = 'completed') / COUNT(*), 3)            AS tasa_completitud,
  ROUND(AVG(IF(status = 'completed', score, NULL)), 2)          AS csat_promedio,
  ROUND(AVG(IF(status = 'completed', duracion_seg, NULL)))      AS duracion_mediana_seg,
  MIN(fecha)                                                    AS primera_respuesta,
  MAX(fecha)                                                    AS ultima_respuesta
FROM `proyecto.experiencia_clientes.survey_responses`
WHERE canal LIKE 'qr-%'
GROUP BY 1, 2, 3, 4, 5;


-- Adhesivos que dejaron de reportar: candidatos a estar despegados, tapados
-- o sin señal. Se revisa contra el inventario de qr/enlaces.csv.
CREATE OR REPLACE VIEW `proyecto.experiencia_clientes.v_qr_sin_actividad` AS
SELECT
  canal,
  touchpoint,
  MAX(fecha)                                    AS ultima_respuesta,
  DATE_DIFF(CURRENT_DATE(), MAX(fecha), DAY)    AS dias_sin_responder,
  COUNT(*)                                      AS respuestas_historicas
FROM `proyecto.experiencia_clientes.survey_responses`
WHERE canal LIKE 'qr-%'
GROUP BY 1, 2
HAVING dias_sin_responder >= 14
ORDER BY dias_sin_responder DESC;

