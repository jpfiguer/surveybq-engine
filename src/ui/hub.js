/*!
 * surveyBQ — hub.js
 * Portada: encuestas disponibles, generador de enlaces para los QR del mall y
 * exportación de las respuestas recogidas hacia BigQuery.
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ;
  var doc = global.document;
  var el = SBQ.render.el;
  var esc = SBQ.util.esc;

  var refs = {};

  function boot() {
    refs.lista   = doc.getElementById('sbq-lista');
    refs.datos   = doc.getElementById('sbq-datos');
    refs.enlace  = doc.getElementById('sbq-enlace');
    refs.config  = doc.getElementById('sbq-config');

    dibujarLista();
    dibujarGeneradorEnlaces();
    dibujarDatos();
    dibujarConfig();
  }

  function toast(msg) {
    var t = doc.getElementById('sbq-toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.classList.remove('is-on'); }, 2200);
  }

  // ------------------------------------------------------------- encuestas --

  function dibujarLista() {
    refs.lista.innerHTML = '';

    SBQ.listSurveys().forEach(function (s) {
      var live = SBQ.Model.normalize(SBQ.getSurvey(s.id));
      var nq = SBQ.Model.allQuestions(live)
        .filter(function (q) { return q.type !== 'html'; }).length;

      var tile = el('div', 'sbq-tile');
      tile.appendChild(el('h3', null, esc(s.title)));
      tile.appendChild(el('p', 'sbq-muted', esc(s.description || '')));

      var badges = el('div', 'sbq-row');
      badges.style.margin = '10px 0 14px';
      badges.appendChild(el('span', 'sbq-badge', s.pages + ' páginas'));
      badges.appendChild(el('span', 'sbq-badge', nq + ' preguntas'));
      badges.appendChild(el('span', 'sbq-badge',
        SBQ.Model.tipoDeIndicador(SBQ.Model.normalize(live)) || '—'));
      if (s.edited) badges.appendChild(el('span', 'sbq-badge is-warn', 'editada'));
      var n = SBQ.storage.countResponses(s.id);
      if (n) badges.appendChild(el('span', 'sbq-badge is-ok', n + ' respuestas'));
      tile.appendChild(badges);

      var acciones = el('div', 'sbq-row');
      var responder = el('a', 'sbq-btn sbq-btn-primary sbq-btn-sm', 'Responder');
      responder.href = 'responder.html?survey=' + encodeURIComponent(s.id);
      var editar = el('a', 'sbq-btn sbq-btn-sm', 'Editar');
      editar.href = 'editor.html?survey=' + encodeURIComponent(s.id);
      var panel = el('a', 'sbq-btn sbq-btn-sm', 'Resultados');
      panel.href = 'panel.html?survey=' + encodeURIComponent(s.id);
      var papel = el('a', 'sbq-btn sbq-btn-sm', 'Imprimir');
      papel.href = 'imprimir.html?survey=' + encodeURIComponent(s.id);
      acciones.appendChild(responder);
      acciones.appendChild(editar);
      acciones.appendChild(panel);
      acciones.appendChild(papel);
      tile.appendChild(acciones);

      refs.lista.appendChild(tile);
    });
  }

  // ------------------------------------------------- generador de enlaces --

  function dibujarGeneradorEnlaces() {
    refs.enlace.innerHTML = '';

    var ids = Object.keys(SBQ.surveys);
    var estado = { survey: ids[0], prefill: {} };

    var selSurvey = doc.createElement('select');
    selSurvey.className = 'sbq-select';
    ids.forEach(function (id) {
      var o = doc.createElement('option');
      o.value = id;
      o.textContent = SBQ.surveys[id].title;
      selSurvey.appendChild(o);
    });

    var campos = el('div', 'sbq-stack');
    var salida = el('div');

    function preguntasPrecargables(sv) {
      return SBQ.Model.allQuestions(sv).filter(function (q) {
        return q.role === 'context' && q.choices && q.choices.length;
      });
    }

    function refrescarCampos() {
      estado.survey = selSurvey.value;
      estado.prefill = {};
      campos.innerHTML = '';
      // Normalizar: en las definiciones las opciones pueden venir como texto
      // plano, y aquí se necesitan como {value, text}.
      var sv = SBQ.Model.normalize(SBQ.getSurvey(estado.survey));

      preguntasPrecargables(sv).forEach(function (q) {
        var wrap = el('div', 'sbq-field');
        wrap.appendChild(el('label', null, esc(q.title || q.id)));
        var s = doc.createElement('select');
        s.className = 'sbq-select';
        var vacio = doc.createElement('option');
        vacio.value = '';
        vacio.textContent = '— preguntar al responder —';
        s.appendChild(vacio);
        q.choices.forEach(function (c) {
          var o = doc.createElement('option');
          o.value = String(c.value);
          o.textContent = c.text;
          s.appendChild(o);
        });
        s.onchange = function () {
          if (s.value) estado.prefill[q.id] = s.value;
          else delete estado.prefill[q.id];
          refrescarSalida();
        };
        wrap.appendChild(s);
        campos.appendChild(wrap);
      });

      var etiqueta = el('div', 'sbq-field');
      etiqueta.appendChild(el('label', null, 'Etiqueta de origen (canal)'));
      var inp = doc.createElement('input');
      inp.className = 'sbq-input';
      inp.placeholder = 'qr-sector-a';
      inp.oninput = function () {
        if (inp.value) estado.prefill.canal = inp.value;
        else delete estado.prefill.canal;
        refrescarSalida();
      };
      etiqueta.appendChild(inp);
      etiqueta.appendChild(el('div', 'sbq-help',
        'Viaja a BigQuery en la columna <code>canal</code>. Útil para saber qué QR generó la respuesta.'));
      campos.appendChild(etiqueta);

      refrescarSalida();
    }

    function construirURL() {
      var base = global.location.href.replace(/[^/]*$/, '') + 'responder.html';
      var qs = ['survey=' + encodeURIComponent(estado.survey)];
      Object.keys(estado.prefill).forEach(function (k) {
        qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(estado.prefill[k]));
      });
      return base + '?' + qs.join('&');
    }

    function refrescarSalida() {
      salida.innerHTML = '';
      var url = construirURL();

      var caja = doc.createElement('textarea');
      caja.className = 'sbq-textarea sbq-code';
      caja.rows = 3;
      caja.readOnly = true;
      caja.value = url;
      salida.appendChild(caja);

      var fila = el('div', 'sbq-row');
      fila.style.marginTop = '8px';

      var copiar = el('button', 'sbq-btn sbq-btn-sm', 'Copiar enlace');
      copiar.onclick = function () {
        caja.select();
        var ok = false;
        try { ok = doc.execCommand('copy'); } catch (e) {}
        if (!ok && global.navigator.clipboard) {
          global.navigator.clipboard.writeText(url).then(function () { toast('Enlace copiado.'); });
          return;
        }
        toast(ok ? 'Enlace copiado.' : 'Copia manualmente el texto.');
      };

      var abrir = el('a', 'sbq-btn sbq-btn-sm', 'Abrir');
      abrir.href = url;
      abrir.target = '_blank';

      fila.appendChild(copiar);
      fila.appendChild(abrir);
      salida.appendChild(fila);

      salida.appendChild(el('div', 'sbq-help',
        'Convierte este enlace en QR con cualquier generador y pégalo en el punto de servicio. ' +
        'Las preguntas precargadas no se le muestran a quien responde.'));
    }

    selSurvey.onchange = refrescarCampos;

    var f = el('div', 'sbq-field');
    f.appendChild(el('label', null, 'Encuesta'));
    f.appendChild(selSurvey);

    refs.enlace.appendChild(f);
    refs.enlace.appendChild(campos);
    refs.enlace.appendChild(salida);
    refrescarCampos();
  }

  // ------------------------------------------------------------- respuestas -

  function descargar(nombre, contenido, tipo) {
    var blob = new Blob([contenido], { type: tipo + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url; a.download = nombre;
    doc.body.appendChild(a); a.click(); doc.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function dibujarDatos() {
    refs.datos.innerHTML = '';

    var todas = SBQ.storage.listResponses();
    if (!SBQ.storage.disponible()) {
      refs.datos.appendChild(el('div', 'sbq-empty',
        'El navegador tiene el almacenamiento bloqueado; las respuestas no se guardarán.'));
      return;
    }
    if (!todas.length) {
      refs.datos.appendChild(el('div', 'sbq-empty',
        'Aún no hay respuestas en este dispositivo. Responde una encuesta para probar la exportación.'));
      return;
    }

    var completas = todas.filter(function (r) { return r.status === 'completed'; }).length;
    var parciales = todas.filter(function (r) { return r.status === 'partial'; }).length;
    var fuera     = todas.filter(function (r) { return r.status === 'disqualified'; }).length;

    var resumen = el('div', 'sbq-row');
    resumen.style.marginBottom = '14px';
    resumen.appendChild(el('span', 'sbq-badge is-ok', completas + ' completas'));
    if (parciales) resumen.appendChild(el('span', 'sbq-badge is-warn', parciales + ' abandonadas'));
    if (fuera) resumen.appendChild(el('span', 'sbq-badge', fuera + ' fuera de perfil'));
    var pend = SBQ.storage.queueLength();
    if (pend) resumen.appendChild(el('span', 'sbq-badge is-warn', pend + ' por enviar'));
    refs.datos.appendChild(resumen);

    var hoy = new Date().toISOString().slice(0, 10);
    var acciones = el('div', 'sbq-row');

    var bNd = el('button', 'sbq-btn sbq-btn-sm sbq-btn-primary', 'NDJSON para BigQuery');
    bNd.onclick = function () {
      descargar('surveybq_' + hoy + '.ndjson', SBQ.bigquery.toNDJSON(todas), 'application/x-ndjson');
      toast('Descargado. Cárgalo con el comando de bigquery/README.md.');
    };

    var bCsv = el('button', 'sbq-btn sbq-btn-sm', 'CSV plano');
    bCsv.onclick = function () {
      descargar('surveybq_' + hoy + '.csv', SBQ.bigquery.toCSV(todas), 'text/csv');
    };

    var bLargo = el('button', 'sbq-btn sbq-btn-sm', 'CSV largo (1 fila por pregunta)');
    bLargo.onclick = function () {
      descargar('surveybq_largo_' + hoy + '.csv', SBQ.bigquery.toCSVLong(todas), 'text/csv');
    };

    var bJson = el('button', 'sbq-btn sbq-btn-sm', 'JSON crudo');
    bJson.onclick = function () {
      descargar('surveybq_crudo_' + hoy + '.json', JSON.stringify(todas, null, 2), 'application/json');
    };

    var bBorrar = el('button', 'sbq-btn sbq-btn-sm sbq-btn-danger', 'Borrar todo');
    bBorrar.onclick = function () {
      if (!global.confirm('Se borran las ' + todas.length +
                          ' respuestas guardadas en este navegador. ¿Exportaste antes?')) return;
      SBQ.storage.clearResponses();
      dibujarDatos(); dibujarLista();
      toast('Respuestas borradas.');
    };

    [bNd, bCsv, bLargo, bJson, bBorrar].forEach(function (b) { acciones.appendChild(b); });
    refs.datos.appendChild(acciones);

    // Últimas respuestas, para verificar de un vistazo.
    var tabla = el('div');
    tabla.style.marginTop = '16px';
    tabla.style.fontSize = '.82rem';
    todas.slice(-5).reverse().forEach(function (r) {
      var row = SBQ.bigquery.toRow(r);
      var linea = el('div', 'sbq-row');
      linea.style.padding = '7px 0';
      linea.style.borderTop = '1px solid var(--border)';
      linea.appendChild(el('span', 'sbq-badge', esc(row.score_type + ' ' + (row.score != null ? row.score : '—'))));
      linea.appendChild(el('span', null, esc(row.touchpoint || row.palanca || row.survey_title)));
      linea.appendChild(el('span', 'sbq-spacer'));
      linea.appendChild(el('span', 'sbq-muted', esc(row.fecha_inicio.slice(0, 16).replace('T', ' '))));
      tabla.appendChild(linea);
    });
    refs.datos.appendChild(tabla);
  }

  // ---------------------------------------------------------------- config --

  function dibujarConfig() {
    refs.config.innerHTML = '';
    var cfg = SBQ.storage.getConfig();

    var estado = el('div', 'sbq-row');
    estado.style.marginBottom = '12px';
    if (!cfg.endpoint) {
      estado.appendChild(el('span', 'sbq-badge is-warn',
        'Sin endpoint · las respuestas quedan en cada teléfono'));
    } else if (cfg.esLocal) {
      estado.appendChild(el('span', 'sbq-badge is-warn', 'Sobrescrito solo en este navegador'));
    } else {
      estado.appendChild(el('span', 'sbq-badge is-ok', 'Configurado en el despliegue'));
    }
    refs.config.appendChild(estado);

    var f = el('div', 'sbq-field');
    f.appendChild(el('label', null, 'Endpoint de recepción'));
    var inp = doc.createElement('input');
    inp.className = 'sbq-input sbq-code';
    inp.placeholder = 'https://surveybq-ingest-xxxxx.a.run.app';
    inp.value = cfg.endpoint || '';
    f.appendChild(inp);
    f.appendChild(el('div', 'sbq-help',
      'El endpoint que usan los teléfonos que escanean un QR viene en <code>config.js</code>, ' +
      'porque su navegador llega vacío. Lo que se escriba acá <strong>solo aplica a este ' +
      'navegador</strong> y sirve para probar contra otro endpoint sin tocar el despliegue.'));
    refs.config.appendChild(f);

    var acciones = el('div', 'sbq-row');
    var guardar = el('button', 'sbq-btn sbq-btn-sm sbq-btn-primary', 'Guardar en este navegador');
    guardar.onclick = function () {
      SBQ.storage.setConfig({ endpoint: inp.value.trim() });
      toast(inp.value.trim() ? 'Endpoint guardado para este navegador.' : 'Sobrescritura quitada.');
      dibujarConfig();
      dibujarDatos();
    };
    acciones.appendChild(guardar);

    if (cfg.esLocal) {
      var volver = el('button', 'sbq-btn sbq-btn-sm', 'Usar el del despliegue');
      volver.onclick = function () {
        SBQ.storage.resetConfig();
        dibujarConfig();
        toast('Se volvió al endpoint del despliegue.');
      };
      acciones.appendChild(volver);
    }

    if (SBQ.storage.queueLength()) {
      var reintentar = el('button', 'sbq-btn sbq-btn-sm',
        'Reintentar cola (' + SBQ.storage.queueLength() + ')');
      reintentar.onclick = function () {
        SBQ.storage.flushQueue().then(function (n) {
          toast(n + ' respuesta(s) enviadas.');
          dibujarConfig(); dibujarDatos();
        });
      };
      acciones.appendChild(reintentar);
    }
    refs.config.appendChild(acciones);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

})(typeof window !== 'undefined' ? window : globalThis);
