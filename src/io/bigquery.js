/*!
 * surveyBQ — bigquery.js
 * Convierte el resultado del respondedor en una fila lista para BigQuery.
 *
 * Los nombres de columna replican la pestaña Base_Analisis del archivo
 * CSAT_MAM_ordenado_v2.xlsx (en snake_case), para que la data nueva se apile
 * con la histórica de Qualtrics sin renombrar nada:
 *
 *   Centro_Comercial -> centro_comercial     Palanca        -> palanca
 *   Fecha_Inicio     -> fecha_inicio         Palanca_otro   -> palanca_otro
 *   Touchpoint       -> touchpoint           Causa_raiz_... -> causa_raiz
 *   CSAT             -> score                Sector_Contexto-> sector_contexto
 *   CSAT_Satisfecho  -> csat_satisfecho      ResponseID     -> response_id
 *
 * El detalle pregunta a pregunta viaja en el campo repetido `answers`, para no
 * perder nada cuando la encuesta se edite y aparezcan preguntas nuevas.
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ || (global.SBQ = {});

  var DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

  /** Franja horaria de la visita. Bandas fijas y documentadas. */
  function franja(d) {
    var h = d.getHours();
    if (h < 11) return 'Antes de 11:00';
    if (h < 15) return '11:00 a 14:59';
    if (h < 20) return '15:00 a 19:59';
    return '20:00 o más';
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fechaLocal(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function mesLocal(d)   { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }

  function bucketCSAT(score) {
    if (score == null) return null;
    if (score >= 4) return 'Satisfecho';
    if (score === 3) return 'Neutro';
    return 'Insatisfecho';
  }

  function bucketNPS(score) {
    if (score == null) return null;
    if (score >= 9) return 'Promotor';
    if (score >= 7) return 'Pasivo';
    return 'Detractor';
  }

  function asText(v) {
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return v.length ? v.join(' | ') : null;
    return String(v);
  }

  function asList(v) {
    if (v === null || v === undefined || v === '') return [];
    return Array.isArray(v) ? v.map(String) : [String(v)];
  }

  function asNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  /**
   * Resultado del runtime -> fila de BigQuery.
   * @param {object} result salida de Runtime#result()
   * @param {object} [extra] campos adicionales (p.ej. { canal: 'qr-sector-a' })
   */
  function toRow(result, extra) {
    var vals = result.values || {};
    var inicio = new Date(result.started_at);
    var termino = new Date(result.finished_at);

    // Se ubican por "role" para que sigan funcionando si el editor renombra
    // o mueve preguntas.
    function byRole(role) {
      return (result.answers || []).filter(function (a) { return a.role === role; });
    }
    function firstText(role) {
      var a = byRole(role)[0];
      return a ? asText(a.value_text) : null;
    }

    var scoreAnswer = byRole('score')[0];
    var score = scoreAnswer ? asNumber(scoreAnswer.value_raw) : null;
    // Lo declara la encuesta (ver Runtime.tipoDeIndicador). El id se mantiene
    // solo por compatibilidad con respuestas guardadas antes de que existiera
    // ese campo.
    var scoreType = (result.settings_score_type) ||
                    (result.survey_id === 'nps-relacional' ? 'NPS' : 'CSAT');

    var esNPS = scoreType === 'NPS';

    var driverAnswer = byRole('driver')[0];
    var causaAnswers = byRole('root_cause');

    var causas = [];
    var causaOtro = null;
    causaAnswers.forEach(function (a) {
      (a.value_codes || asList(a.value_text)).forEach(function (t) {
        if (causas.indexOf(t) < 0) causas.push(t);
      });
      if (a.other_text) causaOtro = a.other_text;
    });

    var row = {
      // --- identidad -------------------------------------------------------
      response_id: result.response_id,
      survey_id: result.survey_id,
      survey_version: result.survey_version,
      survey_title: result.survey_title,
      status: result.status,

      // --- contexto --------------------------------------------------------
      centro_comercial: vals.centro_comercial || null,
      touchpoint: asText(vals.touchpoint),
      sector_contexto: asText(vals.sector_contexto),

      // --- indicador -------------------------------------------------------
      score_type: scoreType,
      score: score,
      score_bucket: esNPS ? bucketNPS(score) : bucketCSAT(score),
      csat_satisfecho: esNPS ? null : (score == null ? null : score >= 4),

      // --- drivers ---------------------------------------------------------
      palanca: driverAnswer
        ? asText(driverAnswer.value_codes || driverAnswer.value_text)
        : null,
      palanca_otro: driverAnswer ? (driverAnswer.other_text || null) : null,
      causa_raiz: causas,
      causa_raiz_otro: causaOtro,
      comentario_abierto: firstText('verbatim'),

      // --- perfil ----------------------------------------------------------
      genero: asText(vals.genero),
      rango_etario: asText(vals.rango_etario),

      // --- tiempos ---------------------------------------------------------
      fecha_inicio: result.started_at,
      fecha_termino: result.finished_at,
      fecha: fechaLocal(inicio),
      mes: mesLocal(inicio),
      dia_semana: DIAS[inicio.getDay()],
      horario: franja(inicio),
      duracion_seg: result.duration_seconds,
      progreso: result.progress,
      finalizado: result.status === 'completed',

      // --- detalle completo ------------------------------------------------
      answers: (result.answers || []).map(function (a) {
        return {
          page_id: a.page_id,
          question_id: a.question_id,
          question_title: a.question_title,
          question_type: a.question_type,
          role: a.role,
          value_text: asText(a.value_text),
          value_number: asNumber(Array.isArray(a.value_raw) ? null : a.value_raw),
          values: a.value_codes || asList(a.value_text),
          other_text: a.other_text || null
        };
      }),

      // --- cliente ---------------------------------------------------------
      // Solo el conteo y los nombres: el contenido de los adjuntos no va a
      // BigQuery. Si se necesitan, se suben a un bucket y se guarda la URL.
      adjuntos: (result.attachments || []).reduce(function (n, a) {
        return n + (a.archivos ? a.archivos.length : (a.firma ? 1 : 0));
      }, 0),
      idioma_respuesta: result.locale || null,
      puntaje: result.score_quiz ? result.score_quiz.obtenido : null,
      puntaje_maximo: result.score_quiz ? result.score_quiz.maximo : null,

      canal: (result.client && result.client.source) || 'web',
      user_agent: result.client ? result.client.user_agent : null,
      idioma: result.client ? result.client.language : null,
      ingested_at: new Date().toISOString()
    };

    if (extra) Object.keys(extra).forEach(function (k) { row[k] = extra[k]; });
    return row;
  }

  /** NDJSON: un JSON por línea, el formato que espera `bq load`. */
  function toNDJSON(results, extra) {
    return results.map(function (r) { return JSON.stringify(toRow(r, extra)); }).join('\n');
  }

  /** Columnas planas del CSV (sin el detalle anidado). */
  var CSV_COLS = [
    'response_id', 'survey_id', 'survey_version', 'status', 'centro_comercial',
    'touchpoint', 'sector_contexto', 'score_type', 'score', 'score_bucket',
    'csat_satisfecho', 'palanca', 'palanca_otro', 'causa_raiz', 'causa_raiz_otro',
    'comentario_abierto', 'genero', 'rango_etario', 'fecha_inicio', 'fecha_termino',
    'fecha', 'mes', 'dia_semana', 'horario', 'duracion_seg', 'progreso',
    'finalizado', 'canal'
  ];

  function csvCell(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) v = v.join(' | ');
    v = String(v);
    return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  /** CSV plano para analistas. Con BOM para que Excel respete los acentos. */
  function toCSV(results, extra) {
    var lines = [CSV_COLS.join(',')];
    results.forEach(function (r) {
      var row = toRow(r, extra);
      lines.push(CSV_COLS.map(function (c) { return csvCell(row[c]); }).join(','));
    });
    return '﻿' + lines.join('\n');
  }

  /** CSV largo: una fila por respuesta y pregunta. Ideal para cruzar drivers. */
  function toCSVLong(results) {
    var cols = ['response_id', 'survey_id', 'touchpoint', 'score', 'page_id',
                'question_id', 'question_title', 'question_type', 'role',
                'value_text', 'other_text'];
    var lines = [cols.join(',')];
    results.forEach(function (r) {
      var row = toRow(r);
      row.answers.forEach(function (a) {
        lines.push([
          row.response_id, row.survey_id, row.touchpoint, row.score,
          a.page_id, a.question_id, a.question_title, a.question_type, a.role,
          a.value_text, a.other_text
        ].map(csvCell).join(','));
      });
    });
    return '﻿' + lines.join('\n');
  }

  SBQ.bigquery = {
    toRow: toRow,
    toNDJSON: toNDJSON,
    toCSV: toCSV,
    toCSVLong: toCSVLong,
    CSV_COLS: CSV_COLS,
    bucketCSAT: bucketCSAT,
    bucketNPS: bucketNPS
  };

})(typeof window !== 'undefined' ? window : globalThis);
