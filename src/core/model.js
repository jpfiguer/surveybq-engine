/*!
 * surveyBQ — model.js
 * Normalización, validación y utilidades del modelo de encuesta.
 *
 * Una encuesta es un objeto JSON puro:
 * {
 *   id, version, title, description,
 *   settings: { showProgress, progressStyle, requiredByDefault, thankYou, disqualified },
 *   variables: { clave: valor },      // se inyectan en los valores y en el piping
 *   pages: [ { id, title, description, visibleIf, elements: [ pregunta ] } ]
 * }
 *
 * Tipos de pregunta soportados:
 *   rating    escala numérica (CSAT 1-5, NPS 0-10) con etiquetas en los extremos
 *   radio     opción única
 *   checkbox  opción múltiple (admite opciones exclusivas)
 *   dropdown  lista desplegable
 *   text      texto corto
 *   comment   texto largo
 *   boolean   sí / no
 *   html      bloque informativo, no captura respuesta
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ || (global.SBQ = {});
  var util = SBQ.util;

  var INPUT_TYPES = [
    'rating', 'radio', 'checkbox', 'dropdown', 'tagbox', 'text', 'comment',
    'boolean', 'matrix', 'ranking', 'multipletext', 'imagepicker', 'file',
    'signature', 'paneldynamic'
  ];
  // panel agrupa otras preguntas; expression y html solo muestran.
  var ALL_TYPES = INPUT_TYPES.concat(['panel', 'expression', 'html']);

  var TYPE_LABELS = {
    rating: 'Escala (CSAT / NPS / CES)',
    radio: 'Opción única',
    checkbox: 'Opción múltiple',
    dropdown: 'Lista desplegable',
    tagbox: 'Selección múltiple compacta',
    text: 'Texto corto',
    comment: 'Texto largo',
    boolean: 'Sí / No',
    matrix: 'Matriz de evaluación',
    ranking: 'Ordenar por preferencia',
    multipletext: 'Varios campos de texto',
    imagepicker: 'Elegir por imagen',
    file: 'Adjuntar foto o archivo',
    signature: 'Firma',
    panel: 'Grupo de preguntas',
    paneldynamic: 'Grupo repetible',
    expression: 'Valor calculado',
    html: 'Bloque informativo'
  };

  /** Tipos cuya respuesta es una lista. */
  var MULTI_TYPES = ['checkbox', 'tagbox', 'ranking', 'file'];

  /** Tipos que agrupan otras preguntas. */
  var CONTAINER_TYPES = ['panel', 'paneldynamic'];

  /** Tipos que no capturan respuesta del encuestado. */
  var DISPLAY_TYPES = ['html', 'panel'];

  /** Tipos que ofrecen alternativas. */
  var CHOICE_TYPES = ['radio', 'checkbox', 'dropdown', 'tagbox', 'ranking', 'imagepicker'];

  /** Conserva los objetos multi-idioma; el resto lo pasa a texto. */
  function textoOMultiidioma(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    return String(v);
  }

  /**
   * Resuelve un texto multi-idioma.
   *
   *   'Hola'                     -> 'Hola'
   *   { es: 'Hola', en: 'Hi' }   -> según el idioma activo
   *
   * Si falta el idioma pedido cae al de la encuesta, y si tampoco está, al
   * primero que exista: mostrar el texto en otro idioma es mejor que dejar la
   * pregunta en blanco.
   */
  function localized(valor, locale, porDefecto) {
    if (valor === null || valor === undefined) return valor;
    if (typeof valor !== 'object' || Array.isArray(valor)) return valor;

    if (locale && valor[locale] !== undefined) return valor[locale];
    if (porDefecto && valor[porDefecto] !== undefined) return valor[porDefecto];
    if (valor['default'] !== undefined) return valor['default'];

    var claves = Object.keys(valor);
    return claves.length ? valor[claves[0]] : '';
  }

  /** Idiomas presentes en la encuesta, mirando todos sus textos. */
  function locales(survey) {
    var encontrados = {};
    function mirar(v) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.keys(v).forEach(function (k) { encontrados[k] = true; });
      }
    }
    (survey.pages || []).forEach(function (p) {
      mirar(p.title); mirar(p.description);
      (p.elements || []).forEach(function recorrer(q) {
        mirar(q.title); mirar(q.description); mirar(q.html); mirar(q.placeholder);
        mirar(q.minLabel); mirar(q.maxLabel); mirar(q.otherText);
        // `rows` está sobrecargado: en `comment` es el alto del textarea
        // (un número) y en `matrix` es la lista de filas. Hay que comprobarlo.
        function lista(v, campo) {
          if (Array.isArray(v)) v.forEach(function (x) { mirar(x && x[campo]); });
        }
        lista(q.choices, 'text');
        lista(q.rows, 'text');
        lista(q.columns, 'text');
        lista(q.items, 'title');
        mirar(q.panelTitle); mirar(q.addText); mirar(q.removeText);
        if (Array.isArray(q.elements)) q.elements.forEach(recorrer);
        if (Array.isArray(q.templateElements)) q.templateElements.forEach(recorrer);
      });
    });
    var lista = Object.keys(encontrados);
    if (survey.locale && lista.indexOf(survey.locale) < 0) lista.unshift(survey.locale);
    return lista;
  }

  /**
   * Normaliza una opción a {value, text, ...}.
   *
   * Los campos extra se conservan tal cual: son los que permiten redactar bien
   * cada rama sin duplicar preguntas ({touchpoint.frase}) y los que se usarán
   * para etiquetar opciones con su código de auditoría.
   */
  function normalizeChoice(c) {
    if (c == null) return null;
    if (typeof c === 'string' || typeof c === 'number' || typeof c === 'boolean') {
      return { value: c, text: String(c) };
    }
    var out = {};
    Object.keys(c).forEach(function (k) { out[k] = c[k]; });
    out.value = c.value !== undefined ? c.value : c.text;
    // No forzar a texto: `text` puede ser un objeto multi-idioma y
    // String() lo dejaría en "[object Object]".
    out.text = c.text !== undefined ? textoOMultiidioma(c.text) : String(c.value);
    if (out.description !== undefined) out.description = textoOMultiidioma(out.description);
    return out;
  }

  /** Normaliza una pregunta, aplicando valores por defecto. */
  function normalizeQuestion(q, survey) {
    if (!q || !q.type) throw new Error('surveyBQ: pregunta sin "type".');
    if (ALL_TYPES.indexOf(q.type) < 0) {
      throw new Error('surveyBQ: tipo de pregunta desconocido "' + q.type + '".');
    }

    var out = util.clone(q);
    if (!out.id) out.id = util.uid('q');

    var requiredByDefault = survey && survey.settings && survey.settings.requiredByDefault;
    if (out.required === undefined) {
      out.required = out.type === 'html' ? false : !!requiredByDefault;
    }

    if (out.type === 'rating') {
      if (out.rateMin === undefined) out.rateMin = 1;
      if (out.rateMax === undefined) out.rateMax = 5;
      if (!out.rateStep) out.rateStep = 1;
      if (!out.displayMode) out.displayMode = 'numbers';
    }

    if (out.choices) {
      out.choices = out.choices.map(normalizeChoice).filter(Boolean);
    }

    // Matriz: filas a evaluar × columnas de la escala.
    if (out.type === 'matrix') {
      out.rows = (out.rows || []).map(normalizeChoice).filter(Boolean);
      out.columns = (out.columns || []).map(normalizeChoice).filter(Boolean);
      if (out.eachRowRequired === undefined) out.eachRowRequired = out.required;
    }

    // Varios campos cortos bajo un mismo enunciado.
    if (out.type === 'multipletext') {
      out.items = (out.items || []).map(function (it, i) {
        if (typeof it === 'string') return { name: it, title: it };
        var c = util.clone(it);
        if (!c.name) c.name = 'campo' + (i + 1);
        if (c.title === undefined) c.title = c.name;
        return c;
      });
    }

    if (out.type === 'file') {
      if (out.maxFiles === undefined) out.maxFiles = 3;
      // 5 MB: una foto de teléfono comprimida entra de sobra y evita que un
      // video accidental llene el almacenamiento del navegador.
      if (out.maxSizeMB === undefined) out.maxSizeMB = 5;
      if (!out.accept) out.accept = 'image/*';
    }

    if (out.type === 'panel') {
      out.elements = (out.elements || []).map(function (e) {
        return normalizeQuestion(e, survey);
      });
    }

    // Grupo repetible: `templateElements` es el molde que se copia por entrada.
    if (out.type === 'paneldynamic') {
      out.templateElements = (out.templateElements || out.elements || [])
        .map(function (e) { return normalizeQuestion(e, survey); });
      delete out.elements;
      if (out.minPanels === undefined) out.minPanels = 1;
      if (out.maxPanels === undefined) out.maxPanels = 10;
      if (!out.panelTitle) out.panelTitle = 'Elemento {n}';
      if (!out.addText) out.addText = '+ Agregar';
      if (!out.removeText) out.removeText = 'Quitar';
    }

    if (out.hasOther && !out.otherText) out.otherText = 'Otro, ¿cuál?';

    return out;
  }

  /** Normaliza la encuesta completa. Devuelve una copia lista para ejecutar. */
  function normalize(def) {
    if (!def) throw new Error('surveyBQ: no hay definición de encuesta.');
    var s = util.clone(def);

    s.id = s.id || util.uid('survey');
    s.version = s.version || '1.0.0';
    s.title = s.title || 'Encuesta';
    s.settings = s.settings || {};
    if (s.settings.showProgress === undefined) s.settings.showProgress = true;
    if (s.settings.requiredByDefault === undefined) s.settings.requiredByDefault = false;
    s.variables = s.variables || {};
    s.pages = (s.pages || []).map(function (p, i) {
      var page = util.clone(p) || {};
      page.id = page.id || ('page' + (i + 1));
      page.elements = (page.elements || []).map(function (q) { return normalizeQuestion(q, s); });
      return page;
    });

    return s;
  }

  /**
   * Recorre todas las preguntas, entrando en los paneles.
   * fn recibe (pregunta, página, índicePágina, índiceEnSuContenedor, panelPadre).
   */
  function eachQuestion(survey, fn) {
    (survey.pages || []).forEach(function (page, pi) {
      (function recorrer(elementos, panel) {
        (elementos || []).forEach(function (q, qi) {
          fn(q, page, pi, qi, panel || null);
          if (q.type === 'panel') recorrer(q.elements, q);
          // El molde de un repetible se recorre para validarlo y traducirlo,
          // pero sus preguntas NO guardan valor propio: viven dentro de cada
          // entrada de la lista.
          if (q.type === 'paneldynamic') recorrer(q.templateElements, q);
        });
      })(page.elements, null);
    });
  }

  /** Elementos de una página o panel, aplanando los paneles. */
  function flatten(elementos) {
    var out = [];
    (elementos || []).forEach(function (q) {
      out.push(q);
      if (q.type === 'panel') out = out.concat(flatten(q.elements));
      if (q.type === 'paneldynamic') out = out.concat(flatten(q.templateElements));
    });
    return out;
  }

  /** Todas las preguntas en un array plano. */
  function allQuestions(survey) {
    var out = [];
    eachQuestion(survey, function (q) { out.push(q); });
    return out;
  }

  /** Busca una pregunta por id. */
  /**
   * Qué indicador mide la encuesta: NPS o CSAT.
   *
   * Manda lo que declare la pregunta marcada como indicador; si no lo dice, se
   * deduce de su escala (hasta 10 es NPS, hasta 5 es CSAT). settings.scoreType
   * queda como último recurso, para las encuestas que lo declaraban así.
   *
   * Vive acá porque lo necesitan el runtime, el exportador y el panel, y antes
   * cada uno lo resolvía por su cuenta: el panel miraba solo settings y
   * mostraba CSAT en una encuesta que medía NPS.
   */
  /**
   * Id de la pregunta que lleva el indicador.
   *
   * Manda el rol declarado en la pregunta; settings.scoreQuestion queda como
   * último recurso. Antes solo se miraba settings, así que una encuesta que no
   * lo declaraba —cualquiera creada en el editor— no mostraba indicador en el
   * panel: se rendía antes de calcularlo.
   */
  function preguntaIndicadora(survey) {
    var id = null;
    eachQuestion(survey, function (q) {
      if (!id && q.role === 'score') id = q.id;
    });
    return id || (survey && survey.settings && survey.settings.scoreQuestion) || null;
  }

  function tipoDeIndicador(survey) {
    var tipo = null;
    eachQuestion(survey, function (q) {
      if (tipo || q.role !== 'score') return;
      if (q.scoreType) { tipo = String(q.scoreType).toUpperCase(); return; }
      tipo = (Number(q.rateMax) >= 9) ? 'NPS' : 'CSAT';
    });
    if (tipo) return tipo;
    var s = survey && survey.settings && survey.settings.scoreType;
    return s ? String(s).toUpperCase() : 'CSAT';
  }
  function findQuestion(survey, id) {
    var found = null;
    eachQuestion(survey, function (q) { if (q.id === id) found = q; });
    return found;
  }

  /**
   * Sustituye {referencias} dentro de un texto por los valores actuales.
   *
   *   "¿Por qué calificaste con nota {nps}?"        -> "... con nota 9?"
   *   "...quedaste con {touchpoint.frase}?"          -> "...quedaste con los baños?"
   *
   * La forma con punto ({pregunta.campo}) busca la opción elegida en esa
   * pregunta y devuelve uno de sus campos. Sirve para que un mismo enunciado
   * se redacte bien en cada rama sin duplicar la pregunta.
   */
  function pipe(text, values, survey) {
    if (typeof text !== 'string' || text.indexOf('{') < 0) return text;

    return text.replace(/\{([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?\}/g, function (match, name, field) {
      var v = values ? values[name] : undefined;

      if (field) {
        if (!survey) return '';
        var q = findQuestion(survey, name);
        if (!q || !q.choices) return '';
        var picked = Array.isArray(v) ? v[0] : v;
        var choice = q.choices.filter(function (c) { return c.value === picked; })[0];
        if (!choice) return '';
        var fv = choice[field];
        return fv === undefined || fv === null ? '' : String(fv);
      }

      if (v === undefined || v === null || v === '') return '';
      if (Array.isArray(v)) return v.join(', ');
      if (typeof v === 'object') return v.text !== undefined ? v.text : '';
      return String(v);
    });
  }

  /**
   * Traduce una condición a una instrucción en castellano, para el formulario
   * en papel: ahí no hay lógica que se ejecute, hay que decirle a la persona
   * cuándo saltarse una pregunta.
   *
   *   "{palanca_banos} = 'Limpieza'"
   *     -> "Responde solo si en la 5 marcaste «Limpieza»."
   *
   * Si la condición es demasiado enredada para explicarla en una frase,
   * devuelve null y quien arme el formulario lo redacta a mano. Es preferible
   * a una instrucción a medias, que en papel no tiene cómo corregirse.
   */
  function explicarCondicion(expr, survey, numeros, locale) {
    if (!expr) return null;
    var desc = SBQ.Expression.decompose(expr);
    if (!desc.ok || !desc.clausulas.length) return null;

    function refA(id) {
      var q = findQuestion(survey, id);
      if (q) {
        var n = numeros && numeros[id];
        var titulo = String(localized(q.title, locale, survey.locale) || '').replace(/<[^>]+>/g, '');
        return n ? 'la ' + n : '«' + titulo.slice(0, 40) + '»';
      }

      // Columna derivada: en papel no existe, pero sus preguntas de origen sí.
      // "{driver}" pasa a ser "la 3 o la 4".
      var comp = (survey.computed || []).filter(function (c) { return c.id === id; })[0];
      if (comp) {
        var fuentes = (comp.coalesce || comp.join || [])
          .map(function (src) { return numeros && numeros[src]; })
          .filter(Boolean);
        if (fuentes.length === 1) return 'la ' + fuentes[0];
        if (fuentes.length > 1) {
          return 'la ' + fuentes.slice(0, -1).join(', la ') + ' o la ' + fuentes[fuentes.length - 1];
        }
      }
      return null;
    }

    function valorDe(id, v) {
      var q = findQuestion(survey, id);
      if (q && Array.isArray(q.choices)) {
        var c = q.choices.filter(function (x) { return String(x.value) === String(v); })[0];
        if (c) return '«' + localized(c.text, locale, survey.locale) + '»';
      }
      return '«' + v + '»';
    }

    var partes = [];
    var explicable = true;

    desc.clausulas.forEach(function (c) {
      // Las banderas <id>_fijado marcan que el valor vino precargado por QR.
      // En papel nunca se cumplen, así que la cláusula sobra: la pregunta
      // simplemente va.
      if (/_fijado$/.test(c.ref)) return;

      var ref = refA(c.ref);
      if (!ref) { explicable = false; return; }

      switch (c.op) {
        case '=': case '==':
          partes.push('en ' + ref + ' marcaste ' + valorDe(c.ref, c.valor)); break;
        case '<>': case '!=':
          partes.push('en ' + ref + ' NO marcaste ' + valorDe(c.ref, c.valor)); break;
        case 'anyof':
          partes.push('en ' + ref + ' marcaste ' +
            (Array.isArray(c.valor) ? c.valor.join(', ') : c.valor)); break;
        case 'contains':
          partes.push('en ' + ref + ' incluiste ' + valorDe(c.ref, c.valor)); break;
        case 'notcontains':
          partes.push('en ' + ref + ' no incluiste ' + valorDe(c.ref, c.valor)); break;
        case '>':  partes.push('en ' + ref + ' pusiste más de ' + c.valor); break;
        case '>=': partes.push('en ' + ref + ' pusiste ' + c.valor + ' o más'); break;
        case '<':  partes.push('en ' + ref + ' pusiste menos de ' + c.valor); break;
        case '<=': partes.push('en ' + ref + ' pusiste ' + c.valor + ' o menos'); break;
        case 'notempty': partes.push('respondiste ' + ref); break;
        case 'empty':    partes.push('dejaste ' + ref + ' en blanco'); break;
        default: explicable = false;
      }
    });

    if (!explicable || !partes.length) return null;
    var union = desc.union === 'or' ? ' o si ' : ' y ';
    return 'Responde solo si ' + partes.join(union) + '.';
  }

  /**
   * Revisa una encuesta y devuelve una lista de problemas.
   * Se usa en el editor para avisar antes de publicar.
   */
  function validateSurvey(def) {
    var problems = [];
    var survey;

    try { survey = normalize(def); }
    catch (e) { return [{ level: 'error', where: 'encuesta', message: e.message }]; }

    if (!survey.pages.length) {
      problems.push({ level: 'error', where: 'encuesta', message: 'La encuesta no tiene páginas.' });
    }

    var seen = {};
    var known = {};
    Object.keys(survey.variables).forEach(function (k) { known[k] = true; });
    (survey.computed || []).forEach(function (c) { if (c && c.id) known[c.id] = true; });

    eachQuestion(survey, function (q, page, pi, qi, panel) {
      var where = page.id + ' › ' + q.id;

      // Dentro de un grupo repetible, `panel.<id>` es la forma explícita de
      // apuntar a la propia entrada. Es una referencia válida.
      if (panel && panel.type === 'paneldynamic') known['panel.' + q.id] = true;

      if (seen[q.id]) {
        problems.push({ level: 'error', where: where, questionId: q.id,
          message: 'El id "' + q.id + '" está repetido; los ids deben ser únicos.' });
      }
      seen[q.id] = true;
      known[q.id] = true;
      // Claves auxiliares que el runtime crea junto a cada pregunta:
      //   <id>_otro    texto libre de la opción "Otro"
      //   <id>_fijado  marca de que el valor vino precargado (QR / URL)
      known[q.id + '_otro'] = true;
      known[q.id + '_fijado'] = true;

      if (DISPLAY_TYPES.indexOf(q.type) < 0 && q.type !== 'expression' && !q.title) {
        problems.push({ level: 'warn', where: where, questionId: q.id,
          message: 'La pregunta no tiene enunciado.' });
      }

      if (q.type === 'matrix') {
        if (!q.rows || !q.rows.length) {
          problems.push({ level: 'error', where: where, questionId: q.id,
            message: 'La matriz no tiene filas que evaluar.' });
        }
        if (!q.columns || !q.columns.length) {
          problems.push({ level: 'error', where: where, questionId: q.id,
            message: 'La matriz no tiene columnas de respuesta.' });
        }
      }

      if (q.type === 'multipletext' && (!q.items || !q.items.length)) {
        problems.push({ level: 'error', where: where, questionId: q.id,
          message: 'No hay campos definidos.' });
      }

      if (q.type === 'paneldynamic' && (!q.templateElements || !q.templateElements.length)) {
        problems.push({ level: 'error', where: where, questionId: q.id,
          message: 'El grupo repetible no tiene preguntas dentro.' });
      }

      if (q.type === 'panel' && (!q.elements || !q.elements.length)) {
        problems.push({ level: 'warn', where: where, questionId: q.id,
          message: 'El grupo está vacío.' });
      }

      if (q.type === 'expression' && !q.expression) {
        problems.push({ level: 'error', where: where, questionId: q.id,
          message: 'El valor calculado no tiene expresión.' });
      }

      if (CHOICE_TYPES.indexOf(q.type) >= 0) {
        if (!q.choices || !q.choices.length) {
          problems.push({ level: 'error', where: where, questionId: q.id,
            message: 'Pregunta de alternativas sin opciones.' });
        } else {
          var vals = {};
          q.choices.forEach(function (c) {
            if (vals[c.value]) {
              problems.push({ level: 'warn', where: where, questionId: q.id,
                message: 'Opción repetida: "' + c.value + '".' });
            }
            vals[c.value] = true;
          });
        }
      }

      if (q.type === 'rating' && q.rateMax <= q.rateMin) {
        problems.push({ level: 'error', where: where, questionId: q.id,
          message: 'El máximo de la escala debe ser mayor que el mínimo.' });
      }

      ['visibleIf', 'enableIf', 'requiredIf'].forEach(function (prop) {
        if (!q[prop]) return;
        var res = SBQ.Expression.validate(q[prop]);
        if (!res.ok) {
          problems.push({ level: 'error', where: where, questionId: q.id,
            message: prop + ' inválida: ' + res.error });
        }
      });
    });

    survey.pages.forEach(function (page) {
      if (!page.visibleIf) return;
      var res = SBQ.Expression.validate(page.visibleIf);
      if (!res.ok) {
        problems.push({ level: 'error', where: page.id,
          message: 'visibleIf de página inválida: ' + res.error });
      }
    });

    // Referencias a preguntas que no existen (se revisa después de recolectar los ids).
    eachQuestion(survey, function (q, page) {
      ['visibleIf', 'enableIf', 'requiredIf'].forEach(function (prop) {
        if (!q[prop]) return;
        var deps;
        try { deps = SBQ.Expression.dependencies(q[prop]); } catch (e) { return; }
        deps.forEach(function (d) {
          if (!known[d]) {
            problems.push({ level: 'warn', where: page.id + ' › ' + q.id, questionId: q.id,
              message: prop + ' referencia "{' + d + '}", que no es una pregunta ni una variable.' });
          }
        });
      });
    });

    return problems;
  }

  SBQ.Model = {
    normalize: normalize,
    normalizeQuestion: normalizeQuestion,
    normalizeChoice: normalizeChoice,
    eachQuestion: eachQuestion,
    allQuestions: allQuestions,
    findQuestion: findQuestion,
    tipoDeIndicador: tipoDeIndicador,
    preguntaIndicadora: preguntaIndicadora,
    pipe: pipe,
    validateSurvey: validateSurvey,
    explicarCondicion: explicarCondicion,
    localized: localized,
    locales: locales,
    flatten: flatten,
    INPUT_TYPES: INPUT_TYPES,
    ALL_TYPES: ALL_TYPES,
    TYPE_LABELS: TYPE_LABELS,
    MULTI_TYPES: MULTI_TYPES,
    CONTAINER_TYPES: CONTAINER_TYPES,
    DISPLAY_TYPES: DISPLAY_TYPES,
    CHOICE_TYPES: CHOICE_TYPES
  };

})(typeof window !== 'undefined' ? window : globalThis);
