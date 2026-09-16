/*!
 * surveyBQ — motor de encuestas propio (Bequarks)
 * registry.js — espacio de nombres global y registro de encuestas.
 *
 * Se carga con <script> clásico (sin módulos ES) a propósito: así el proyecto
 * funciona tanto servido por HTTP como abierto directamente desde file://,
 * sin build, sin npm y sin dependencias externas.
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ || (global.SBQ = {});

  SBQ.version = '1.0.1';

  /** Encuestas registradas, por id. */
  SBQ.surveys = SBQ.surveys || {};

  /**
   * Registra una definición de encuesta. Los archivos de surveys/*.js llaman
   * a esta función al cargarse.
   * @param {object} def definición de encuesta
   * @returns {object} la misma definición
   */
  SBQ.registerSurvey = function (def) {
    if (!def || !def.id) throw new Error('surveyBQ: la encuesta necesita un "id".');
    SBQ.surveys[def.id] = def;
    return def;
  };

  /** Devuelve una encuesta registrada (o la versión editada guardada en local). */
  /**
   * La encuesta que se debe usar, por orden de precedencia:
   *   1. el borrador local, si quien abre está editando en este navegador
   *   2. la versión publicada desde el editor, si se alcanzó a traer
   *   3. la que viene en el archivo desplegado
   *
   * La publicada se guarda en SBQ.publicadas antes de arrancar (ver
   * traerPublicada); acá solo se elige, sin esperar red.
   */
  SBQ.publicadas = {};

  SBQ.getSurvey = function (id) {
    if (SBQ.storage && typeof SBQ.storage.loadDraft === 'function') {
      var draft = SBQ.storage.loadDraft(id);
      if (draft) return draft;
    }
    if (SBQ.publicadas[id]) return SBQ.publicadas[id];
    return SBQ.surveys[id] || null;
  };

  /**
   * Trae la versión publicada de una encuesta antes de dibujarla.
   *
   * Se espera poco y con red se falla hacia el archivo: quien escanea un QR en
   * un subterráneo con mala señal tiene que ver la encuesta igual, aunque sea
   * la versión anterior. Nunca se queda esperando.
   */
  SBQ.traerPublicada = function (id, msTope) {
    var url = (SBQ.config && SBQ.config.encuestasEndpoint) || '';
    if (!url || !global.fetch) return Promise.resolve(false);

    var corte = new Promise(function (res) {
      global.setTimeout(function () { res('tarde'); }, msTope || 1500);
    });
    var pedido = global.fetch(url + '?id=' + encodeURIComponent(id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.ok && d.survey && d.survey.id === id) {
          SBQ.publicadas[id] = d.survey;
          return true;
        }
        return false;
      })
      .catch(function () { return false; });

    return Promise.race([pedido, corte]).then(function (r) { return r === true; });
  };

  /** Lista de encuestas disponibles, con marca de si tienen edición local. */
  SBQ.listSurveys = function () {
    return Object.keys(SBQ.surveys).map(function (id) {
      var base = SBQ.surveys[id];
      var edited = SBQ.storage && SBQ.storage.loadDraft ? !!SBQ.storage.loadDraft(id) : false;
      var live = SBQ.getSurvey(id);
      return {
        id: id,
        title: live.title || base.title,
        description: live.description || base.description,
        version: live.version || base.version,
        edited: edited,
        pages: (live.pages || []).length
      };
    });
  };

  /** Utilidades compartidas. */
  SBQ.util = {
    /** Clon profundo por JSON (las definiciones son datos puros). */
    clone: function (o) { return o == null ? o : JSON.parse(JSON.stringify(o)); },

    /** id corto y razonablemente único, sin dependencias. */
    uid: function (prefix) {
      var s = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      return (prefix || 'id') + '_' + s;
    },

    /** UUID v4 usando crypto cuando está disponible. */
    uuid: function () {
      if (global.crypto && typeof global.crypto.randomUUID === 'function') {
        return global.crypto.randomUUID();
      }
      var buf;
      if (global.crypto && global.crypto.getRandomValues) {
        buf = new Uint8Array(16);
        global.crypto.getRandomValues(buf);
      } else {
        buf = [];
        for (var i = 0; i < 16; i++) buf.push(Math.floor(Math.random() * 256));
      }
      buf[6] = (buf[6] & 0x0f) | 0x40;
      buf[8] = (buf[8] & 0x3f) | 0x80;
      var hex = [];
      for (var j = 0; j < 16; j++) hex.push((buf[j] + 0x100).toString(16).slice(1));
      return hex.slice(0, 4).join('') + '-' + hex.slice(4, 6).join('') + '-' +
             hex.slice(6, 8).join('') + '-' + hex.slice(8, 10).join('') + '-' +
             hex.slice(10, 16).join('');
    },

    /** Escapa texto para insertarlo como HTML. */
    esc: function (s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /** Mezcla Fisher-Yates (para "alternativas aleatorias"). */
    shuffle: function (arr) {
      var a = arr.slice();
      for (var i = a.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    },

    /** Parámetros de la URL como objeto plano. */
    queryParams: function () {
      var out = {};
      var qs = (global.location && global.location.search || '').replace(/^\?/, '');
      if (!qs) return out;
      qs.split('&').forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf('=');
        var k = i < 0 ? pair : pair.slice(0, i);
        var v = i < 0 ? '' : pair.slice(i + 1);
        try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); }
        catch (e) { out[k] = v; }
      });
      return out;
    }
  };

})(typeof window !== 'undefined' ? window : globalThis);
