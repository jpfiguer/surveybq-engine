/*!
 * surveyBQ — analisis.js
 * Agregación de respuestas. Va aparte de la interfaz a propósito: así los
 * conteos se pueden probar sin navegador, que es donde de verdad se cometen
 * los errores de análisis.
 *
 * Toda función recibe la lista de resultados tal como los guarda el runtime.
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ || (global.SBQ = {});
  var Model = SBQ.Model;

  function vacio(v) {
    return v === null || v === undefined || v === '' ||
           (Array.isArray(v) && !v.length);
  }

  /* Alias entre el formato del respondedor y el de BigQuery: la misma respuesta
     puede venir con started_at/duration_seconds (respondedor) o con
     fecha_inicio/duracion_seg (columnas de la tabla). */
  function inicioDe(r) { return r.started_at || r.fecha_inicio || null; }
  function duracionDe(r) {
    var d = r.duration_seconds != null ? r.duration_seconds : r.duracion_seg;
    return d == null ? null : Number(d);
  }

  /* Columnas planas de la fila BigQuery que corresponden a una pregunta por su
     rol, no por su id. El score va por rol porque su id cambia (csat, nps). */
  var COLUMNA_PLANA = {
    touchpoint: 'touchpoint', sector_contexto: 'sector_contexto',
    palanca: 'palanca', causa_raiz: 'causa_raiz',
    genero: 'genero', rango_etario: 'rango_etario',
    comentario_abierto: 'comentario_abierto'
  };

  /** Respuesta de una pregunta, tomada del detalle, los valores o la fila plana. */
  function respuestaDe(r, id) {
    var a = (r.answers || []).filter(function (x) { return x.question_id === id; })[0];
    if (a) return a;
    if (r.values && r.values[id] !== undefined) {
      return { question_id: id, value_raw: r.values[id], value_codes: null, value_text: r.values[id] };
    }
    // Fila de BigQuery sin answers para esta pregunta: caer a la columna plana.
    var col = COLUMNA_PLANA[id];
    if (col && r[col] !== undefined && r[col] !== null && r[col] !== '') {
      return { question_id: id, value_raw: r[col],
               values: Array.isArray(r[col]) ? r[col].map(String) : [String(r[col])],
               value_text: r[col] };
    }
    return null;
  }

  /**
   * Valores codificados de una respuesta, siempre como lista.
   *
   * Tolera los dos formatos que puede tener un archivo importado:
   *   · el del respondedor   answers[].value_codes / value_raw + values{}
   *   · el de BigQuery        answers[].values (ya codificado) + columnas planas
   * Así el mismo panel sirve tanto para las respuestas del navegador como para
   * lo que se exporta de la tabla.
   */
  function codigosDe(r, id) {
    var a = respuestaDe(r, id);
    if (!a) return [];
    if (a.value_codes && a.value_codes.length) return a.value_codes;
    if (a.values && a.values.length) return a.values;           // formato BigQuery
    var v = a.value_raw;
    if (vacio(v)) return [];
    return (Array.isArray(v) ? v : [v]).map(String);
  }

  // ------------------------------------------------------------------ filtros

  /**
   * Aplica filtros. Cada filtro es { id, valores: [...] } y se cumple si la
   * respuesta incluye alguno de esos valores; entre filtros distintos se exige
   * que se cumplan todos.
   */
  function filtrar(respuestas, filtros, desde, hasta) {
    return respuestas.filter(function (r) {
      var inicio = inicioDe(r);
      if (desde && inicio && String(inicio) < desde) return false;
      if (hasta && inicio && String(inicio) > hasta + 'T23:59:59Z') return false;

      return (filtros || []).every(function (f) {
        if (!f.valores || !f.valores.length) return true;
        var cods = codigosDe(r, f.id);
        return cods.some(function (c) { return f.valores.indexOf(c) >= 0; });
      });
    });
  }

  // ------------------------------------------------------------------- KPIs

  function resumen(respuestas, survey) {
    var total = respuestas.length;
    var completas = respuestas.filter(function (r) { return r.status === 'completed'; });
    var parciales = respuestas.filter(function (r) { return r.status === 'partial'; }).length;
    var fuera = respuestas.filter(function (r) { return r.status === 'disqualified'; }).length;

    var duraciones = completas.map(duracionDe)
      .filter(function (d) { return typeof d === 'number' && d > 0; }).sort(function (a, b) { return a - b; });

    var out = {
      total: total,
      completas: completas.length,
      parciales: parciales,
      fuera: fuera,
      tasaCompletitud: total ? completas.length / total : null,
      // Mediana, no promedio: un solo encuestado que deja la pestaña abierta
      // media hora arrastra el promedio y no dice nada del resto.
      duracionMediana: duraciones.length ? duraciones[Math.floor(duraciones.length / 2)] : null,
      indicador: null
    };

    var qScore = SBQ.Model.preguntaIndicadora(survey);
    // Misma regla que el runtime y el exportador: la declara la pregunta
    // indicadora, no solo settings.
    var tipo = SBQ.Model.tipoDeIndicador(survey);
    if (!qScore) return out;

    /* El indicador se calcula sobre TODA respuesta que dio nota, aunque después
       haya abandonado: la nota ya se entregó y descartarla sesga el resultado.
       Es además el criterio del histórico de Qualtrics, cuyo Resumen_CSAT
       cuenta 3.328 respuestas con nota sobre 3.784 registros. Cambiar esto
       haría que el panel discrepe de los reportes que ya circulan. */
    var notas = respuestas.map(function (r) {
      // En la fila BigQuery la nota es la columna plana `score`; en el formato
      // del respondedor es la respuesta de la pregunta indicadora.
      var v = r.score !== undefined && r.score !== null ? r.score : codigosDe(r, qScore)[0];
      return Number(v);
    }).filter(function (n) { return !isNaN(n); });
    if (!notas.length) return out;

    out.indicador = tipo === 'NPS' ? nps(notas) : csat(notas);
    out.indicador.tipo = tipo || 'CSAT';
    out.indicador.n = notas.length;
    return out;
  }

  function csat(notas) {
    var satisfechos = notas.filter(function (n) { return n >= 4; }).length;
    var neutros = notas.filter(function (n) { return n === 3; }).length;
    return {
      valor: satisfechos / notas.length,
      formato: 'porcentaje',
      promedio: notas.reduce(function (s, n) { return s + n; }, 0) / notas.length,
      grupos: [
        { id: 'insatisfecho', texto: 'Insatisfecho (1-2)', n: notas.length - satisfechos - neutros },
        { id: 'neutro',       texto: 'Neutro (3)',         n: neutros },
        { id: 'satisfecho',   texto: 'Satisfecho (4-5)',   n: satisfechos }
      ]
    };
  }

  function nps(notas) {
    var prom = notas.filter(function (n) { return n >= 9; }).length;
    var pas  = notas.filter(function (n) { return n >= 7 && n <= 8; }).length;
    var det  = notas.length - prom - pas;
    return {
      valor: (prom - det) / notas.length * 100,
      formato: 'nps',
      promedio: notas.reduce(function (s, n) { return s + n; }, 0) / notas.length,
      grupos: [
        { id: 'detractor', texto: 'Detractor (0-6)', n: det },
        { id: 'pasivo',    texto: 'Pasivo (7-8)',    n: pas },
        { id: 'promotor',  texto: 'Promotor (9-10)', n: prom }
      ]
    };
  }

  // ---------------------------------------------------------- distribuciones

  /**
   * Conteo por alternativa.
   *
   * `base` distingue dos denominadores que se confunden seguido:
   *   respuestas  cuántas veces se marcó   (suma > n en multi-respuesta)
   *   personas    sobre cuántos respondieron la pregunta
   * En multi-respuesta el porcentaje útil es sobre personas, y suma más de 100%.
   */
  function distribucion(respuestas, q) {
    var conteo = {};
    var personas = 0;
    var totalMarcas = 0;

    respuestas.forEach(function (r) {
      var cods = codigosDe(r, q.id);
      if (!cods.length) return;
      personas++;
      cods.forEach(function (c) {
        conteo[c] = (conteo[c] || 0) + 1;
        totalMarcas++;
      });
    });

    // Orden: el de la definición si existe, para que no baile entre filtros.
    var orden = [];
    if (q.type === 'rating') {
      for (var v = q.rateMin; v <= q.rateMax; v += (q.rateStep || 1)) orden.push(String(v));
    } else if (Array.isArray(q.choices)) {
      orden = q.choices.map(function (c) { return String(c.value); });
      if (q.hasOther) orden.push('Otro');
    }
    Object.keys(conteo).forEach(function (k) { if (orden.indexOf(k) < 0) orden.push(k); });

    var multi = Model.MULTI_TYPES.indexOf(q.type) >= 0;

    return {
      personas: personas,
      totalMarcas: totalMarcas,
      multi: multi,
      base: multi ? 'personas' : 'respuestas',
      items: orden.filter(function (k) { return conteo[k]; }).map(function (k) {
        return {
          valor: k,
          n: conteo[k],
          pct: personas ? conteo[k] / personas : 0
        };
      })
    };
  }

  /** Una fila por aspecto de la matriz, con su reparto por columna. */
  function matriz(respuestas, q) {
    return (q.rows || []).map(function (fila) {
      var conteo = {};
      var n = 0;
      respuestas.forEach(function (r) {
        var a = respuestaDe(r, q.id);
        if (!a) return;
        var v = a.value_raw;
        // Puede venir como objeto o ya codificado "fila=columna".
        var col = (v && typeof v === 'object' && !Array.isArray(v))
          ? v[fila.value]
          : (codigosDe(r, q.id).filter(function (c) {
              return c.indexOf(fila.value + '=') === 0;
            })[0] || '').split('=')[1];
        if (vacio(col)) return;
        conteo[col] = (conteo[col] || 0) + 1;
        n++;
      });

      var numeros = [];
      Object.keys(conteo).forEach(function (c) {
        var num = Number(c);
        if (!isNaN(num)) for (var i = 0; i < conteo[c]; i++) numeros.push(num);
      });

      return {
        fila: fila,
        n: n,
        promedio: numeros.length
          ? numeros.reduce(function (s, x) { return s + x; }, 0) / numeros.length : null,
        columnas: (q.columns || []).map(function (col) {
          return { col: col, n: conteo[col.value] || 0,
                   pct: n ? (conteo[col.value] || 0) / n : 0 };
        })
      };
    });
  }

  /** Posición promedio de cada opción en una pregunta de ordenamiento. */
  function ranking(respuestas, q) {
    var suma = {}, veces = {};
    respuestas.forEach(function (r) {
      var orden = codigosDe(r, q.id);
      orden.forEach(function (v, i) {
        suma[v] = (suma[v] || 0) + (i + 1);
        veces[v] = (veces[v] || 0) + 1;
      });
    });
    return (q.choices || []).map(function (c) {
      var k = String(c.value);
      return { opcion: c, n: veces[k] || 0,
               posicion: veces[k] ? suma[k] / veces[k] : null };
    }).filter(function (x) { return x.n; })
      .sort(function (a, b) { return a.posicion - b.posicion; });
  }

  /** Cruce de dos preguntas: filas = A, series = B. */
  function cruce(respuestas, qA, qB) {
    var filas = {};
    var seriesVistas = {};

    respuestas.forEach(function (r) {
      var a = codigosDe(r, qA.id);
      var b = codigosDe(r, qB.id);
      if (!a.length || !b.length) return;
      a.forEach(function (va) {
        filas[va] = filas[va] || { total: 0, series: {} };
        b.forEach(function (vb) {
          filas[va].series[vb] = (filas[va].series[vb] || 0) + 1;
          filas[va].total++;
          seriesVistas[vb] = (seriesVistas[vb] || 0) + 1;
        });
      });
    });

    // Máximo 8 series: más allá los colores dejan de distinguirse. El resto
    // se agrupa en "Otros" en vez de inventar tonos nuevos.
    var series = Object.keys(seriesVistas)
      .sort(function (x, y) { return seriesVistas[y] - seriesVistas[x]; });
    var visibles = series.slice(0, 7);
    var agrupa = series.length > 8;
    if (agrupa) visibles.push('Otros');
    else visibles = series;

    return {
      series: visibles,
      agrupadas: agrupa ? series.slice(7) : [],
      filas: Object.keys(filas).map(function (k) {
        var f = filas[k];
        var vals = visibles.map(function (s) {
          if (s === 'Otros' && agrupa) {
            return series.slice(7).reduce(function (n, x) { return n + (f.series[x] || 0); }, 0);
          }
          return f.series[s] || 0;
        });
        return { valor: k, total: f.total, valores: vals };
      }).sort(function (x, y) { return y.total - x.total; })
    };
  }

  // ------------------------------------------------------------- texto libre

  function verbatims(respuestas, q) {
    var out = [];
    respuestas.forEach(function (r) {
      var a = respuestaDe(r, q.id);
      if (!a || vacio(a.value_raw)) return;
      out.push({
        texto: String(a.value_text || a.value_raw),
        fecha: inicioDe(r),
        response_id: r.response_id,
        contexto: r.values || {}
      });
    });
    return out;
  }

  /* Palabras que no aportan nada al conteo. No es una lista exhaustiva de
     stopwords del español: es la mínima que evita que "de", "la" y "que"
     copen el resultado. */
  var VACIAS = ('de la que el en y a los del se las por un para con no una su al lo como mas ' +
    'pero sus le ya o este si porque esta entre cuando muy sin sobre tambien me hasta hay ' +
    'donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e ' +
    'esto mi antes algunos qué unos yo otro otras otra él tanto esa estos mucho quienes nada ' +
    'muchos cual poco ella estar estas algunas algo nosotros mi tu te ti tu son fue era es ' +
    'ha han hay habia ser esta estaba tiene tienen tenia mas menos').split(' ');

  function palabras(respuestas, q, tope) {
    var conteo = {};
    verbatims(respuestas, q).forEach(function (v) {
      String(v.texto).toLowerCase()
        .replace(/[.,;:!¡?¿"'()\[\]{}…—–-]/g, ' ')
        .split(/\s+/)
        .forEach(function (p) {
          if (p.length < 4) return;
          if (VACIAS.indexOf(p) >= 0) return;
          conteo[p] = (conteo[p] || 0) + 1;
        });
    });
    return Object.keys(conteo)
      .map(function (p) { return { palabra: p, n: conteo[p] }; })
      .filter(function (x) { return x.n > 1; })
      .sort(function (a, b) { return b.n - a.n; })
      .slice(0, tope || 30);
  }

  /** Serie temporal del indicador principal, por día o mes. */
  function serieTemporal(respuestas, survey, granularidad) {
    var qScore = SBQ.Model.preguntaIndicadora(survey);
    if (!qScore) return [];
    var corte = granularidad === 'mes' ? 7 : 10;
    var grupos = {};

    respuestas.forEach(function (r) {
      // Mismo criterio que resumen(): cuenta quien dio nota, no solo quien
      // llegó al final. La nota puede venir en la columna plana (BigQuery).
      var bruto = r.score !== undefined && r.score !== null ? r.score : codigosDe(r, qScore)[0];
      var n = Number(bruto);
      if (isNaN(n)) return;
      var inicio = inicioDe(r);
      if (!inicio) return;
      var k = String(inicio).slice(0, corte);
      (grupos[k] = grupos[k] || []).push(n);
    });

    var tipo = SBQ.Model.tipoDeIndicador(survey);
    return Object.keys(grupos).sort().map(function (k) {
      var notas = grupos[k];
      var ind = tipo === 'NPS' ? nps(notas) : csat(notas);
      return { periodo: k, n: notas.length, valor: ind.valor, promedio: ind.promedio };
    });
  }

  SBQ.analisis = {
    filtrar: filtrar,
    resumen: resumen,
    distribucion: distribucion,
    matriz: matriz,
    ranking: ranking,
    cruce: cruce,
    verbatims: verbatims,
    palabras: palabras,
    serieTemporal: serieTemporal,
    codigosDe: codigosDe,
    respuestaDe: respuestaDe
  };

})(typeof window !== 'undefined' ? window : globalThis);
