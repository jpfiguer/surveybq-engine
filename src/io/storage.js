/*!
 * surveyBQ — storage.js
 * Persistencia en el navegador: respuestas recogidas, borradores del editor y
 * envío opcional a un endpoint HTTP. Todo tolera que localStorage no exista o
 * esté bloqueado (modo incógnito, cookies deshabilitadas).
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ || (global.SBQ = {});

  var K_RESPONSES = 'sbq:responses';
  var K_DRAFT     = 'sbq:draft:';
  var K_QUEUE     = 'sbq:queue';
  var K_CONFIG    = 'sbq:config';

  function ls() {
    try {
      var s = global.localStorage;
      s.setItem('sbq:probe', '1'); s.removeItem('sbq:probe');
      return s;
    } catch (e) { return null; }
  }

  function read(key, fallback) {
    var s = ls();
    if (!s) return fallback;
    try {
      var raw = s.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function write(key, value) {
    var s = ls();
    if (!s) return false;
    try { s.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { console.warn('surveyBQ: no se pudo guardar en localStorage.', e); return false; }
  }

  var storage = {
    disponible: function () { return !!ls(); },

    // ------------------------------------------------------------ respuestas
    /** Guarda una respuesta completa y devuelve el total acumulado. */
    saveResponse: function (result) {
      var all = read(K_RESPONSES, []);
      all.push(result);
      write(K_RESPONSES, all);
      return all.length;
    },

    listResponses: function (surveyId) {
      var all = read(K_RESPONSES, []);
      return surveyId ? all.filter(function (r) { return r.survey_id === surveyId; }) : all;
    },

    countResponses: function (surveyId) { return storage.listResponses(surveyId).length; },

    clearResponses: function (surveyId) {
      if (!surveyId) { write(K_RESPONSES, []); return; }
      write(K_RESPONSES, read(K_RESPONSES, []).filter(function (r) {
        return r.survey_id !== surveyId;
      }));
    },

    // -------------------------------------------------- borradores del editor
    /** Guarda la versión editada de una encuesta (la que usa el respondedor). */
    saveDraft: function (survey) {
      if (!survey || !survey.id) return false;
      return write(K_DRAFT + survey.id, {
        savedAt: new Date().toISOString(),
        survey: survey
      });
    },

    loadDraft: function (surveyId) {
      var d = read(K_DRAFT + surveyId, null);
      return d && d.survey ? d.survey : null;
    },

    draftInfo: function (surveyId) {
      var d = read(K_DRAFT + surveyId, null);
      return d ? { savedAt: d.savedAt } : null;
    },

    discardDraft: function (surveyId) {
      var s = ls();
      if (s) { try { s.removeItem(K_DRAFT + surveyId); } catch (e) {} }
    },

    // ------------------------------------------------- sesión a medio hacer

    /* Se guarda una sesión por encuesta. Si alguien responde dos veces sin
       terminar, la segunda pisa a la primera: guardar una cola de sesiones
       abandonadas complicaría el retomar sin resolver ningún caso real. */
    saveSession: function (snap) {
      if (!snap || !snap.survey_id) return false;
      return write('sbq:sesion:' + snap.survey_id, snap);
    },

    loadSession: function (surveyId) { return read('sbq:sesion:' + surveyId, null); },

    clearSession: function (surveyId) {
      var s = ls();
      if (s) { try { s.removeItem('sbq:sesion:' + surveyId); } catch (e) {} }
    },

    // -------------------------------------------------------------- endpoint

    /**
     * Configuración efectiva: la que viaja con la aplicación (config.js) más
     * lo que se haya sobrescrito en este navegador.
     *
     * El orden importa. Si solo se leyera localStorage, quien escanea un QR
     * llegaría sin endpoint y su respuesta se quedaría en su teléfono: la
     * configuración tiene que venir con el despliegue.
     */
    /**
     * Configuración de envío. Con `surveyId` devuelve el destino de esa
     * encuesta si tiene uno propio: cada cliente escribe en su proyecto y las
     * respuestas de uno no pueden caer en la infraestructura de otro.
     *
     * La sobrescritura local del navegador manda sobre todo, porque existe
     * justamente para probar contra otro endpoint.
     */
    getConfig: function (surveyId) {
      var base = (SBQ.config || {});
      var local = read(K_CONFIG, {});
      var propio = surveyId && base.endpointPorEncuesta
                   ? base.endpointPorEncuesta[surveyId] : '';
      return {
        endpoint: local.endpoint !== undefined && local.endpoint !== ''
          ? local.endpoint : (propio || base.endpoint || ''),
        origen: local.origen || base.origen || 'surveybq-web',
        // Solo se considera sobrescrito si la clave existe de verdad.
        esLocal: local.endpoint !== undefined && local.endpoint !== ''
      };
    },

    setConfig: function (cfg) { write(K_CONFIG, cfg); },

    /** Vuelve a la configuración que trae el despliegue. */
    resetConfig: function () {
      var s = ls();
      if (s) { try { s.removeItem(K_CONFIG); } catch (e) {} }
    },

    /**
     * Envía una respuesta al endpoint configurado. Si falla, la deja en cola
     * para reintentar (los mall tienen wifi irregular).
     */
    send: function (result) {
      var cfg = storage.getConfig(result && result.survey_id);
      if (!cfg.endpoint) return Promise.resolve({ sent: false, reason: 'sin endpoint' });

      return global.fetch(cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-SBQ-Origen': cfg.origen
        },
        body: JSON.stringify(SBQ.bigquery ? SBQ.bigquery.toRow(result) : result)
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return { sent: true };
      }).catch(function (err) {
        var q = read(K_QUEUE, []);
        q.push(result);
        write(K_QUEUE, q);
        return { sent: false, queued: true, reason: err.message };
      });
    },

    queueLength: function () { return read(K_QUEUE, []).length; },

    /**
     * Reintenta la cola pendiente, en lotes.
     *
     * El endpoint acepta hasta 50 por envío, así que una cola de 40 respuestas
     * acumuladas tras una tarde sin señal sale en una petición y no en 40.
     * Lo que falle vuelve a la cola: nunca se descarta una respuesta por un
     * error de red.
     */
    flushQueue: function () {
      var q = read(K_QUEUE, []);
      if (!q.length) return Promise.resolve(0);

      // La cola puede mezclar encuestas de clientes distintos, y cada una va a
      // su propio proyecto. Se agrupa por destino antes de enviar; si no, las
      // respuestas de un cliente terminarían en la infraestructura de otro.
      var porDestino = {};
      var sinDestino = [];
      q.forEach(function (r) {
        var cfg = storage.getConfig(r && r.survey_id);
        if (!cfg.endpoint) { sinDestino.push(r); return; }
        (porDestino[cfg.endpoint] = porDestino[cfg.endpoint] || []).push(r);
      });

      var destinos = Object.keys(porDestino);
      if (!destinos.length) return Promise.resolve(0);

      write(K_QUEUE, sinDestino);
      var enviadas = 0;
      var fallidas = [];
      var origen = storage.getConfig().origen;

      var envios = [];
      destinos.forEach(function (url) {
        var pend = porDestino[url];
        for (var i = 0; i < pend.length; i += 50) envios.push({ url: url, lote: pend.slice(i, i + 50) });
      });

      return envios.reduce(function (cadena, envio) {
        return cadena.then(function () {
          return global.fetch(envio.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-SBQ-Origen': origen },
            body: JSON.stringify(envio.lote.map(function (r) {
              return SBQ.bigquery ? SBQ.bigquery.toRow(r) : r;
            }))
          }).then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            enviadas += envio.lote.length;
          }).catch(function () {
            fallidas = fallidas.concat(envio.lote);
          });
        });
      }, Promise.resolve()).then(function () {
        if (fallidas.length) write(K_QUEUE, read(K_QUEUE, []).concat(fallidas));
        return enviadas;
      });
    },

    /**
     * Reintenta solo al recuperar la conexión.
     *
     * Sin esto, una respuesta que falló en el subterráneo se queda en cola
     * hasta que alguien abra la portada y apriete el botón, que en un piloto
     * no pasa nunca.
     */
    autoReintentar: function () {
      if (!global.addEventListener) return;
      if (storage._autoRetryOn) return;
      storage._autoRetryOn = true;

      global.addEventListener('online', function () {
        if (storage.queueLength()) {
          storage.flushQueue().then(function (n) {
            if (n) console.log('surveyBQ: ' + n + ' respuesta(s) pendientes enviadas.');
          });
        }
      });
    }
  };

  SBQ.storage = storage;

})(typeof window !== 'undefined' ? window : globalThis);
