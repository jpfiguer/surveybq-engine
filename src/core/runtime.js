/*!
 * surveyBQ — runtime.js
 * Máquina de estado del respondedor: valores, visibilidad, navegación,
 * validación y construcción del resultado final.
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ || (global.SBQ = {});
  var Expr = SBQ.Expression;
  var Model = SBQ.Model;
  var util = SBQ.util;

  /** Valor sentinela que guarda la opción "Otro". El texto libre va en <id>_otro. */
  var OTHER = '__otro__';

  function Runtime(def, options) {
    options = options || {};

    this.survey = Model.normalize(def);
    this.options = options;
    this.locale = options.locale || this.survey.locale || 'es';
    /* Solo lectura: se dibuja igual, pero nada se puede cambiar. Sirve para
       revisar una respuesta enviada en la misma interfaz en que se respondió,
       sin construir una segunda vista que se desincronice. */
    this.readOnly = !!options.readOnly;
    this.state = 'running';               // running | completed | disqualified
    this.pageIndex = 0;
    this.errors = {};                     // { questionId: 'mensaje' }
    this.showErrors = false;
    this.startedAt = new Date();
    this.finishedAt = null;
    this.responseId = options.responseId || util.uuid();
    this._orderCache = {};                // orden aleatorio estable por pregunta

    // Valores iniciales: variables de la encuesta + prefill (URL, contexto).
    this.values = {};
    var self = this;
    Object.keys(this.survey.variables).forEach(function (k) {
      self.values[k] = self.survey.variables[k];
    });
    // Los valores precargados (QR, parámetros de URL, contexto del sistema) se
    // marcan como "fijos": su pregunta queda oculta a propósito, y la limpieza
    // de respuestas huérfanas no debe borrarlos.
    this.fixed = {};
    if (options.prefill) {
      Object.keys(options.prefill).forEach(function (k) {
        if (options.prefill[k] !== undefined && options.prefill[k] !== '') {
          self.values[k] = options.prefill[k];
          self.fixed[k] = true;
        }
      });
    }

    this.cleanInvisible();
  }

  Runtime.OTHER = OTHER;

  /**
   * Resuelve un texto para mostrarlo: primero elige el idioma, después
   * reemplaza las {referencias}. En ese orden, porque el texto traducido
   * también puede llevar referencias.
   */
  Runtime.prototype.t = function (valor) {
    var texto = Model.localized(valor, this.locale, this.survey.locale);
    return Model.pipe(texto, this.values, this.survey);
  };

  /** Cambia de idioma en caliente. */
  Runtime.prototype.setLocale = function (locale) {
    this.locale = locale;
    if (typeof this.options.onChange === 'function') {
      this.options.onChange('__locale__', locale, this);
    }
  };

  /** Idiomas disponibles en la encuesta. */
  Runtime.prototype.availableLocales = function () {
    return Model.locales(this.survey);
  };

  // -------------------------------------------------------------- visibilidad

  Runtime.prototype.isPageVisible = function (page) {
    var visible;
    try { visible = Expr.evaluate(page.visibleIf, this.values); }
    catch (e) {
      console.warn('surveyBQ: visibleIf de página inválida en', page.id, e.message);
      visible = true;
    }
    if (!visible) return false;

    // Una página cuyas preguntas quedaron todas ocultas no se muestra. Pasa,
    // por ejemplo, con las palancas que no tienen causas propias: quien
    // responde se topaba con una pantalla en blanco y tenía que apretar
    // Continuar sin nada que contestar.
    return this.tieneContenido(page);
  };

  /**
   * ¿La página tiene algo que mostrar?
   *
   * Un panel no cuenta por sí mismo —puede estar visible y venir vacío—, así
   * que se mira dentro. Un texto informativo sí cuenta: es contenido aunque
   * no se responda.
   */
  Runtime.prototype.tieneContenido = function (page) {
    var self = this;
    var hay = false;
    (function recorrer(elementos) {
      (elementos || []).forEach(function (q) {
        if (hay || !self.isQuestionVisible(q)) return;
        if (q.type === 'panel') recorrer(q.elements);
        else hay = true;
      });
    })(page.elements);
    return hay;
  };

  Runtime.prototype.isQuestionVisible = function (q) {
    try { return Expr.evaluate(q.visibleIf, this.values); }
    catch (e) { console.warn('surveyBQ: visibleIf inválida en', q.id, e.message); return true; }
  };

  Runtime.prototype.isQuestionEnabled = function (q) {
    try { return Expr.evaluate(q.enableIf, this.values); }
    catch (e) { return true; }
  };

  Runtime.prototype.isQuestionRequired = function (q) {
    if (q.requiredIf) {
      try { return Expr.evaluate(q.requiredIf, this.values); }
      catch (e) { return !!q.required; }
    }
    return !!q.required;
  };

  /** Páginas visibles según los valores actuales. */
  Runtime.prototype.visiblePages = function () {
    var self = this;
    return this.survey.pages.filter(function (p) { return self.isPageVisible(p); });
  };

  /**
   * Elementos visibles directos de una página o panel. Es lo que dibuja la
   * interfaz: conserva la jerarquía, con los paneles como un elemento más.
   */
  Runtime.prototype.visibleElements = function (contenedor) {
    var self = this;
    return (contenedor.elements || []).filter(function (q) {
      return self.isQuestionVisible(q);
    });
  };

  /**
   * Preguntas visibles de una página, aplanando los paneles. Es lo que usan
   * la validación y el resultado: un panel oculto oculta todo lo suyo.
   */
  Runtime.prototype.visibleQuestions = function (page) {
    var self = this;
    var out = [];
    (function recorrer(elementos) {
      (elementos || []).forEach(function (q) {
        if (!self.isQuestionVisible(q)) return;
        out.push(q);
        if (q.type === 'panel') recorrer(q.elements);
      });
    })(page.elements);
    return out;
  };

  Runtime.prototype.currentPage = function () {
    var pages = this.visiblePages();
    if (!pages.length) return null;
    if (this.pageIndex >= pages.length) this.pageIndex = pages.length - 1;
    if (this.pageIndex < 0) this.pageIndex = 0;
    return pages[this.pageIndex];
  };

  /**
   * Borra las respuestas de preguntas que dejaron de estar visibles.
   * Es lo que hace que al cambiar de touchpoint no queden palancas ni causas
   * raíz de otro touchpoint contaminando el resultado.
   */
  Runtime.prototype.cleanInvisible = function () {
    var self = this;
    var changed = true;
    var guard = 0;

    while (changed && guard++ < 20) {
      changed = false;
      var visiblePageIds = {};
      this.visiblePages().forEach(function (p) { visiblePageIds[p.id] = true; });

      Model.eachQuestion(this.survey, function (q, page, pi, qi, panel) {
        if (Model.DISPLAY_TYPES.indexOf(q.type) >= 0) return;
        if (panel && panel.type === 'paneldynamic') return;
        // Un panel oculto arrastra a sus hijos: hay que mirar toda la cadena.
        var visible = visiblePageIds[page.id] && self.isQuestionVisible(q) &&
                      (!panel || self.isQuestionVisible(panel));
        if (visible || self.fixed[q.id]) return;
        if (self.values[q.id] !== undefined) { delete self.values[q.id]; changed = true; }
        if (self.values[q.id + '_otro'] !== undefined) { delete self.values[q.id + '_otro']; changed = true; }
      });

      if (this.computeDerived()) changed = true;
    }
  };

  /**
   * Recalcula los valores derivados declarados en survey.computed.
   *
   *   computed: [
   *     { id: 'palanca', coalesce: ['palanca_banos', 'palanca_tiendas', ...] },
   *     { id: 'sector_contexto', join: ['sector_bano', 'genero_bano'], separator: ' / ' }
   *   ]
   *
   * coalesce toma el primer valor no vacío; join concatena todos los no vacíos. Sirve para que una encuesta muy
   * ramificada siga entregando una sola columna limpia (palanca, driver, causa
   * raíz) hacia BigQuery y hacia el piping de los enunciados.
   * Devuelve true si algún derivado cambió.
   */
  Runtime.prototype.computeDerived = function () {
    var self = this;
    var changed = false;

    // Preguntas de tipo expression: su valor sale de una fórmula, no del
    // encuestado, pero viaja al resultado como una respuesta más.
    Model.eachQuestion(this.survey, function (q) {
      if (q.type !== 'expression' || !q.expression) return;
      var val;
      try { val = Expr.evaluateValue(q.expression, self.values); }
      catch (e) { return; }
      // Una fórmula sobre respuestas vacías da NaN. Eso no es un valor: es
      // "todavía no se puede calcular", y debe comportarse como vacío.
      if (typeof val === 'number' && !isFinite(val)) val = undefined;
      if (self.values[q.id] !== val) {
        if (Expr.isEmpty(val)) delete self.values[q.id];
        else self.values[q.id] = val;
        changed = true;
      }
    });

    var list = this.survey.computed;
    if (!list || !list.length) return changed;

    list.forEach(function (def) {
      if (!def || !def.id) return;
      var val, otherVal;

      if (def.join) {
        var partes = [];
        def.join.forEach(function (srcId) {
          var v = self.values[srcId];
          if (Expr.isEmpty(v)) return;
          partes.push(Array.isArray(v) ? v.join(', ') : String(v));
        });
        if (partes.length) val = partes.join(def.separator || ' / ');
      } else if (def.expression) {
        // Derivada calculada: promedios, sumas, cualquier fórmula sobre las
        // respuestas. Antes solo se podía concatenar o tomar la primera con
        // valor, que no alcanza para un promedio.
        try { val = Expr.evaluateValue(def.expression, self.values); }
        catch (e) { val = undefined; }
        if (typeof val === 'number' && !isFinite(val)) val = undefined;
      } else {
        (def.coalesce || []).some(function (srcId) {
          if (Expr.isEmpty(self.values[srcId])) return false;
          val = self.values[srcId];
          otherVal = self.values[srcId + '_otro'];
          return true;
        });
      }

      var prev = self.values[def.id];
      var same = JSON.stringify(prev === undefined ? null : prev) ===
                 JSON.stringify(val === undefined ? null : val);
      if (!same) {
        if (Expr.isEmpty(val)) delete self.values[def.id];
        else self.values[def.id] = val;
        changed = true;
      }

      var prevOther = self.values[def.id + '_otro'];
      if (prevOther !== otherVal) {
        if (Expr.isEmpty(otherVal)) delete self.values[def.id + '_otro'];
        else self.values[def.id + '_otro'] = otherVal;
        changed = true;
      }
    });

    return changed;
  };

  // ------------------------------------------------------------------ valores

  Runtime.prototype.getValue = function (id) { return this.values[id]; };

  Runtime.prototype.setValue = function (id, value) {
    if (this.readOnly) return;
    if (value === undefined || value === null || value === '' ||
        (Array.isArray(value) && !value.length)) {
      delete this.values[id];
    } else {
      this.values[id] = value;
    }
    this.cleanInvisible();
    if (this.showErrors) this.validatePage(this.currentPage());
    if (typeof this.options.onChange === 'function') this.options.onChange(id, value, this);
  };

  /**
   * Alterna una opción en una pregunta de selección múltiple, respetando
   * las opciones exclusivas y el máximo de selecciones.
   */
  Runtime.prototype.toggleChoice = function (q, value, checked) {
    var current = this.values[q.id];
    var list = Array.isArray(current) ? current.slice() : (current ? [current] : []);
    var choice = (q.choices || []).filter(function (c) { return c.value === value; })[0];
    var isExclusive = choice && choice.exclusive;

    if (checked) {
      if (isExclusive) {
        list = [value];
      } else {
        var exclusives = (q.choices || [])
          .filter(function (c) { return c.exclusive; })
          .map(function (c) { return c.value; });
        list = list.filter(function (v) { return exclusives.indexOf(v) < 0; });
        if (list.indexOf(value) < 0) list.push(value);
        if (q.maxSelect && list.length > q.maxSelect) list = list.slice(-q.maxSelect);
      }
    } else {
      list = list.filter(function (v) { return v !== value; });
    }

    this.setValue(q.id, list);
  };

  /** Opciones a mostrar, con "Otro" añadido y orden aleatorio estable si aplica. */
  Runtime.prototype.choicesFor = function (q) {
    var list = (q.choices || []).slice();

    if (q.randomize) {
      if (!this._orderCache[q.id]) {
        // Las opciones marcadas keepAtEnd (p.ej. "Otras razones") no se mezclan.
        var movable = [], fixed = [];
        list.forEach(function (c, i) {
          if (c.keepAtEnd) fixed.push({ c: c, i: i }); else movable.push(c);
        });
        var mixed = util.shuffle(movable).concat(fixed.map(function (f) { return f.c; }));
        this._orderCache[q.id] = mixed.map(function (c) { return c.value; });
      }
      var order = this._orderCache[q.id];
      list.sort(function (a, b) { return order.indexOf(a.value) - order.indexOf(b.value); });
    }

    if (q.hasOther) list.push({ value: OTHER, text: q.otherText || 'Otro, ¿cuál?', isOther: true });
    return list;
  };

  // --------------------------------------------------------------- validación

  Runtime.prototype.isAnswered = function (q) {
    var v = this.values[q.id];
    if (Expr.isEmpty(v)) return false;

    // Matriz: responder una fila de cinco no es responder la pregunta.
    if (q.type === 'matrix' && q.eachRowRequired) {
      var filas = (q.rows || []).map(function (r) { return r.value; });
      return filas.every(function (f) { return !Expr.isEmpty(v[f]); });
    }

    // Varios campos: al menos uno con contenido, o todos si son obligatorios.
    if (q.type === 'multipletext') {
      var nombres = (q.items || []).map(function (i) { return i.name; });
      if (q.allItemsRequired) {
        return nombres.every(function (n) { return !Expr.isEmpty(v[n]); });
      }
      return nombres.some(function (n) { return !Expr.isEmpty(v[n]); });
    }

    // Grupo repetible: cuenta si alguna entrada tiene algo respondido.
    if (q.type === 'paneldynamic') {
      return (Array.isArray(v) ? v : []).some(function (e) {
        return e && Object.keys(e).some(function (k) { return !Expr.isEmpty(e[k]); });
      });
    }

    // Si eligió "Otro", exigimos el detalle en texto libre.
    var pickedOther = Array.isArray(v) ? v.indexOf(OTHER) >= 0 : v === OTHER;
    if (pickedOther && Expr.isEmpty(this.values[q.id + '_otro'])) return false;
    return true;
  };

  /** Marca una casilla de la matriz. */
  Runtime.prototype.setMatrixCell = function (q, fila, columna) {
    var actual = this.values[q.id];
    var v = (actual && typeof actual === 'object' && !Array.isArray(actual))
      ? util.clone(actual) : {};
    if (columna === undefined || columna === null) delete v[fila];
    else v[fila] = columna;
    this.setValue(q.id, Object.keys(v).length ? v : undefined);
  };

  /** Escribe uno de los campos de una pregunta de varios textos. */
  Runtime.prototype.setTextItem = function (q, nombre, texto) {
    var actual = this.values[q.id];
    var v = (actual && typeof actual === 'object' && !Array.isArray(actual))
      ? util.clone(actual) : {};
    if (Expr.isEmpty(texto)) delete v[nombre];
    else v[nombre] = texto;
    this.setValue(q.id, Object.keys(v).length ? v : undefined);
  };

  // ------------------------------------------------------ grupos repetibles

  /** Entradas actuales de un grupo repetible, respetando el mínimo. */
  Runtime.prototype.panelEntries = function (q) {
    var v = this.values[q.id];
    var lista = Array.isArray(v) ? v : [];
    while (lista.length < (q.minPanels || 0)) lista.push({});
    return lista;
  };

  /**
   * Valores visibles desde dentro de una entrada.
   *
   * Se mezclan los de la encuesta con los de la entrada, y además se exponen
   * como `panel.campo`, que es la forma explícita de referirse a la entrada
   * propia cuando un id se repite fuera del grupo.
   */
  Runtime.prototype.entryValues = function (q, i) {
    var entrada = this.panelEntries(q)[i] || {};
    var out = {};
    var self = this;
    Object.keys(this.values).forEach(function (k) { out[k] = self.values[k]; });
    Object.keys(entrada).forEach(function (k) {
      out[k] = entrada[k];
      out['panel.' + k] = entrada[k];
    });
    return out;
  };

  Runtime.prototype.isEntryQuestionVisible = function (q, inner, i) {
    if (!inner.visibleIf) return true;
    try { return Expr.evaluate(inner.visibleIf, this.entryValues(q, i)); }
    catch (e) { return true; }
  };

  Runtime.prototype.setEntryValue = function (q, i, innerId, value) {
    if (this.readOnly) return;
    var lista = this.panelEntries(q).map(function (e) { return util.clone(e); });
    while (lista.length <= i) lista.push({});

    if (Expr.isEmpty(value)) delete lista[i][innerId];
    else lista[i][innerId] = value;

    this.setValue(q.id, lista);
  };

  Runtime.prototype.addPanel = function (q) {
    var lista = this.panelEntries(q).map(function (e) { return util.clone(e); });
    if (lista.length >= (q.maxPanels || 99)) return false;
    lista.push({});
    this.setValue(q.id, lista);
    return true;
  };

  Runtime.prototype.removePanel = function (q, i) {
    var lista = this.panelEntries(q).map(function (e) { return util.clone(e); });
    if (lista.length <= (q.minPanels || 0)) return false;
    lista.splice(i, 1);
    this.setValue(q.id, lista);
    return true;
  };

  /** Mueve un elemento dentro de una pregunta de ordenamiento. */
  Runtime.prototype.moveRankItem = function (q, desde, hacia) {
    var lista = this.rankOrder(q);
    if (hacia < 0 || hacia >= lista.length) return;
    var mov = lista.splice(desde, 1)[0];
    lista.splice(hacia, 0, mov);
    this.setValue(q.id, lista);
  };

  /** Orden actual de una pregunta de ordenamiento (o el orden de origen). */
  Runtime.prototype.rankOrder = function (q) {
    var v = this.values[q.id];
    var todos = (q.choices || []).map(function (c) { return c.value; });
    if (!Array.isArray(v) || !v.length) return todos.slice();
    // Conserva lo ya ordenado y agrega al final lo que se haya sumado después.
    var out = v.filter(function (x) { return todos.indexOf(x) >= 0; });
    todos.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
    return out;
  };

  /** Valida la página indicada. Rellena this.errors y devuelve true/false. */
  Runtime.prototype.validatePage = function (page) {
    this.errors = {};
    if (!page) return true;
    var self = this;

    this.visibleQuestions(page).forEach(function (q) {
      if (q.type === 'html') return;
      var v = self.values[q.id];

      var pickedOther = Array.isArray(v) ? v.indexOf(OTHER) >= 0 : v === OTHER;

      // "Otro" sin detalle no vale, aunque la pregunta sea opcional: el
      // encuestado ya decidió responder y solo le falta completar. Sin esta
      // regla el análisis recibe la categoría "Otro" vacía, que no dice nada.
      if (pickedOther && Expr.isEmpty(self.values[q.id + '_otro'])) {
        self.errors[q.id] = 'Cuéntanos brevemente cuál.';
        return;
      }

      // Grupo repetible: se valida cada entrada contra el molde. Una entrada
      // a medio llenar es tan inservible como una matriz incompleta.
      if (q.type === 'paneldynamic' && Array.isArray(v)) {
        var faltantes = [];
        v.forEach(function (entrada, i) {
          var algo = Object.keys(entrada || {}).some(function (k) {
            return !Expr.isEmpty(entrada[k]);
          });
          (q.templateElements || []).forEach(function (inner) {
            if (!inner.required) return;
            if (!self.isEntryQuestionVisible(q, inner, i)) return;
            // Una entrada intacta no se reclama salvo que el grupo lo exija.
            if (!algo && !self.isQuestionRequired(q)) return;
            if (Expr.isEmpty(entrada && entrada[inner.id])) faltantes.push(i + 1);
          });
        });
        if (faltantes.length) {
          var unicas = faltantes.filter(function (x, k) { return faltantes.indexOf(x) === k; });
          self.errors[q.id] = unicas.length === 1
            ? 'Falta completar el elemento ' + unicas[0] + '.'
            : 'Faltan datos en los elementos ' + unicas.join(', ') + '.';
          return;
        }
      }

      // Una matriz a medio llenar no sirve para nada: si empezó a marcarla,
      // tiene que terminarla, aunque la pregunta sea opcional.
      if (q.type === 'matrix' && q.eachRowRequired && !Expr.isEmpty(v)) {
        var faltan = (q.rows || []).filter(function (r) { return Expr.isEmpty(v[r.value]); });
        if (faltan.length) {
          self.errors[q.id] = faltan.length === 1
            ? 'Falta responder una fila.'
            : 'Faltan ' + faltan.length + ' filas por responder.';
          return;
        }
      }

      // Lo mismo si se marcaron todos los campos como obligatorios.
      if (q.type === 'multipletext' && q.allItemsRequired && !Expr.isEmpty(v)) {
        var vacios = (q.items || []).filter(function (i) { return Expr.isEmpty(v[i.name]); });
        if (vacios.length) {
          self.errors[q.id] = 'Completa todos los campos.';
          return;
        }
      }

      if (self.isQuestionRequired(q) && !self.isAnswered(q)) {
        self.errors[q.id] = q.requiredMessage || 'Esta pregunta es obligatoria.';
        return;
      }

      if (Expr.isEmpty(v)) return;

      var esLista = Array.isArray(v);

      if (esLista && q.minSelect && v.length < q.minSelect) {
        self.errors[q.id] = 'Elige al menos ' + q.minSelect + ' opciones.';
        return;
      }
      if (esLista && q.maxSelect && v.length > q.maxSelect) {
        self.errors[q.id] = 'Elige como máximo ' + q.maxSelect + ' opciones.';
        return;
      }
      if (q.minLength && String(v).length < q.minLength) {
        self.errors[q.id] = 'Escribe al menos ' + q.minLength + ' caracteres.';
        return;
      }
      if (q.maxLength && String(v).length > q.maxLength) {
        self.errors[q.id] = 'Máximo ' + q.maxLength + ' caracteres.';
        return;
      }
      if (q.inputType === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) {
        self.errors[q.id] = 'Escribe un correo válido.';
        return;
      }
      if (q.inputType === 'number' || q.min !== undefined || q.max !== undefined) {
        var n = Number(v);
        if (isNaN(n)) {
          self.errors[q.id] = 'Escribe un número.';
          return;
        }
        if (q.min !== undefined && n < q.min) {
          self.errors[q.id] = 'El mínimo es ' + q.min + '.';
          return;
        }
        if (q.max !== undefined && n > q.max) {
          self.errors[q.id] = 'El máximo es ' + q.max + '.';
          return;
        }
      }
      if (q.pattern) {
        var re;
        try { re = new RegExp(q.pattern); }
        catch (e) { re = null; console.warn('surveyBQ: patrón inválido en', q.id); }
        if (re && !re.test(String(v))) {
          self.errors[q.id] = q.patternMessage || 'El formato no es válido.';
          return;
        }
      }
      // Regla escrita como expresión: la más flexible, evaluada contra todas
      // las respuestas, no solo contra esta.
      if (q.validIf) {
        var ok;
        try { ok = Expr.evaluate(q.validIf, self.values); }
        catch (e) { ok = true; console.warn('surveyBQ: validIf inválida en', q.id, e.message); }
        if (!ok) {
          self.errors[q.id] = q.validMessage || 'La respuesta no cumple la regla definida.';
          return;
        }
      }
      if (q.type === 'file' && q.maxFiles && v.length > q.maxFiles) {
        self.errors[q.id] = 'Máximo ' + q.maxFiles + ' archivo(s).';
      }
    });

    return Object.keys(this.errors).length === 0;
  };

  // --------------------------------------------------------------- navegación

  Runtime.prototype.isFirstPage = function () { return this.pageIndex === 0; };

  Runtime.prototype.isLastPage = function () {
    return this.pageIndex >= this.visiblePages().length - 1;
  };

  /**
   * Ejecuta los disparadores de la encuesta.
   *
   *   triggers: [
   *     { runIf: "{csat} <= 2", complete: true },
   *     { runIf: "{visito_6m} = 'No'", skipTo: 'despedida' },
   *     { runIf: "{nps} >= 9", setValue: { id: 'segmento', value: 'Promotor' } }
   *   ]
   *
   * Se corren al avanzar de página. Devuelve el id de página al que saltar,
   * 'complete' si hay que terminar, o null.
   */
  Runtime.prototype.runTriggers = function () {
    var lista = this.survey.triggers;
    if (!lista || !lista.length) return null;

    var self = this;
    var salto = null;

    lista.forEach(function (t) {
      if (!t || salto === 'complete') return;
      var activo;
      try { activo = Expr.evaluate(t.runIf, self.values); }
      catch (e) { console.warn('surveyBQ: runIf inválida en un disparador', e.message); return; }
      if (!activo) return;

      if (t.setValue && t.setValue.id) {
        self.values[t.setValue.id] = t.setValue.value;
      }
      if (t.clearValue) {
        delete self.values[t.clearValue];
      }
      if (t.complete) { salto = 'complete'; return; }
      if (t.skipTo && salto === null) salto = t.skipTo;
    });

    return salto;
  };

  /**
   * Puntaje tipo cuestionario: suma los puntos de las opciones elegidas.
   * Una opción puntúa con `score`, o con 1 si está marcada como `correct`.
   */
  Runtime.prototype.score = function () {
    var self = this;
    var obtenido = 0, maximo = 0;

    Model.eachQuestion(this.survey, function (q) {
      if (!q.choices || !q.scored) return;

      var puntos = q.choices.map(function (c) {
        return c.score !== undefined ? c.score : (c.correct ? 1 : 0);
      });
      maximo += Math.max.apply(null, puntos.concat([0]));

      if (!self.isQuestionVisible(q)) return;
      var v = self.values[q.id];
      if (Expr.isEmpty(v)) return;

      var elegidas = Array.isArray(v) ? v : [v];
      elegidas.forEach(function (val) {
        var c = q.choices.filter(function (x) { return x.value === val; })[0];
        if (!c) return;
        obtenido += c.score !== undefined ? c.score : (c.correct ? 1 : 0);
      });
    });

    return {
      obtenido: obtenido,
      maximo: maximo,
      porcentaje: maximo ? Math.round((obtenido / maximo) * 100) : null,
      aprobado: this.survey.settings.passingScore !== undefined
        ? obtenido >= this.survey.settings.passingScore
        : null
    };
  };

  /** Comprueba las reglas de término anticipado de la página actual. */
  Runtime.prototype.checkTerminators = function (page) {
    if (!page) return false;
    if (page.disqualifyIf && Expr.evaluate(page.disqualifyIf, this.values)) {
      this.state = 'disqualified';
      this.finishedAt = new Date();
      return true;
    }
    if (page.completeIf && Expr.evaluate(page.completeIf, this.values)) {
      this.complete();
      return true;
    }
    return false;
  };

  /** Avanza. Devuelve true si cambió de página o terminó. */
  Runtime.prototype.next = function () {
    var page = this.currentPage();
    this.showErrors = true;

    if (!this.validatePage(page)) return false;
    if (this.checkTerminators(page)) return true;

    var salto = this.runTriggers();
    if (salto === 'complete') { this.complete(); return true; }
    if (salto) {
      var destino = this.visiblePages().map(function (p) { return p.id; }).indexOf(salto);
      if (destino >= 0) {
        this.showErrors = false;
        this.pageIndex = destino;
        return true;
      }
      console.warn('surveyBQ: el disparador salta a "' + salto + '", que no existe o está oculta.');
    }

    this.showErrors = false;
    if (this.isLastPage()) { this.complete(); return true; }

    this.pageIndex++;
    this.tiempoPagina = 0;
    return true;
  };

  Runtime.prototype.prev = function () {
    if (this.isFirstPage()) return false;
    this.showErrors = false;
    this.errors = {};
    this.pageIndex--;
    this.tiempoPagina = 0;
    return true;
  };

  // -------------------------------------------------------- temporizador

  /**
   * Arranca el reloj si la encuesta o alguna página tiene límite de tiempo.
   *
   *   settings.timeLimit        segundos para toda la encuesta
   *   page.timeLimit            segundos para esa página
   *   settings.onTimeUp         'nextPage' (por defecto) o 'complete'
   *
   * Los dos relojes NO se comportan igual, y la diferencia importa:
   *   · el de la encuesta, al agotarse, siempre cierra: no queda tiempo
   *   · el de una página avanza a la siguiente, salvo que se pida cerrar.
   * Que se acabe el tiempo de una página no debería descartar el resto de la
   * encuesta, así que el valor por defecto es avanzar.
   *
   * En ningún caso se pierde lo respondido: se cierra con lo que haya.
   */
  Runtime.prototype.startTimer = function (onTick) {
    var self = this;
    this.stopTimer();
    if (!this.tieneLimite()) return;

    this.tiempoTotal = 0;
    this.tiempoPagina = 0;
    this._tick = global.setInterval(function () {
      if (self.state !== 'running') return self.stopTimer();
      self.tiempoTotal++;
      self.tiempoPagina++;

      var restante = self.tiempoRestante();
      if (typeof onTick === 'function') onTick(restante, self);

      if (restante.total !== null && restante.total <= 0) return self.seAcaboElTiempo(true);
      if (restante.pagina !== null && restante.pagina <= 0) return self.seAcaboElTiempo(false);
    }, 1000);
  };

  Runtime.prototype.stopTimer = function () {
    if (this._tick) { global.clearInterval(this._tick); this._tick = null; }
  };

  Runtime.prototype.tieneLimite = function () {
    if (this.survey.settings.timeLimit) return true;
    return (this.survey.pages || []).some(function (p) { return p.timeLimit; });
  };

  Runtime.prototype.tiempoRestante = function () {
    var page = this.currentPage();
    return {
      total: this.survey.settings.timeLimit
        ? this.survey.settings.timeLimit - (this.tiempoTotal || 0) : null,
      pagina: (page && page.timeLimit)
        ? page.timeLimit - (this.tiempoPagina || 0) : null
    };
  };

  Runtime.prototype.seAcaboElTiempo = function (esTotal) {
    var accion = this.survey.settings.onTimeUp || 'nextPage';
    this.expiredAt = new Date();
    this.timedOut = true;

    if (esTotal || accion === 'complete' || this.isLastPage()) {
      this.stopTimer();
      this.complete();
      return;
    }
    this.tiempoPagina = 0;
    this.pageIndex++;
    if (typeof this.options.onTimeUp === 'function') this.options.onTimeUp(this);
  };

  Runtime.prototype.complete = function () {
    this.stopTimer();
    this.state = 'completed';
    this.finishedAt = new Date();
    if (typeof this.options.onComplete === 'function') this.options.onComplete(this.result(), this);
  };

  // ----------------------------------------------------------------- progreso

  Runtime.prototype.progress = function () {
    var pages = this.visiblePages();
    if (!pages.length) return 0;
    if (this.state !== 'running') return 100;
    return Math.round((this.pageIndex / pages.length) * 100);
  };

  /** Porcentaje de preguntas visibles efectivamente respondidas. */
  Runtime.prototype.answeredRatio = function () {
    var self = this, total = 0, done = 0;
    this.visiblePages().forEach(function (p) {
      self.visibleQuestions(p).forEach(function (q) {
        if (q.type === 'html') return;
        total++;
        if (self.isAnswered(q)) done++;
      });
    });
    return total ? done / total : 0;
  };

  // ------------------------------------------------------ guardar y seguir

  /**
   * Estado mínimo para retomar después. No incluye la definición de la
   * encuesta: si esta cambió, se retoma sobre la versión nueva, que es lo
   * correcto cuando alguien vuelve días después.
   */
  Runtime.prototype.snapshot = function () {
    return {
      survey_id: this.survey.id,
      survey_version: this.survey.version,
      response_id: this.responseId,
      pageIndex: this.pageIndex,
      locale: this.locale,
      values: util.clone(this.values),
      fixed: util.clone(this.fixed),
      started_at: this.startedAt.toISOString(),
      saved_at: new Date().toISOString()
    };
  };

  /** Retoma una sesión guardada. Devuelve true si se pudo. */
  Runtime.prototype.restore = function (snap) {
    if (!snap || snap.survey_id !== this.survey.id) return false;

    this.values = util.clone(snap.values || {});
    this.fixed = util.clone(snap.fixed || {});
    this.responseId = snap.response_id || this.responseId;
    this.locale = snap.locale || this.locale;
    if (snap.started_at) this.startedAt = new Date(snap.started_at);

    // Limpiar antes de posicionarse: si la encuesta cambió, alguna rama pudo
    // desaparecer y la página guardada ya no existir.
    this.cleanInvisible();
    var paginas = this.visiblePages().length;
    this.pageIndex = Math.min(snap.pageIndex || 0, Math.max(0, paginas - 1));
    return true;
  };

  // ---------------------------------------------------------------- resultado

  /** Texto legible de un valor (resuelve "Otro" al texto escrito). */
  Runtime.prototype.displayValue = function (q) {
    var v = this.values[q.id];
    if (Expr.isEmpty(v)) return null;
    var self = this;

    function label(val) {
      if (val === OTHER) {
        var free = self.values[q.id + '_otro'];
        return free ? String(free) : self.t(q.otherText) || 'Otro';
      }
      var c = (q.choices || []).filter(function (x) { return x.value === val; })[0];
      return c ? self.t(c.text) : String(val);
    }

    // Matriz: "Limpieza: Bueno · Rapidez: Regular"
    if (q.type === 'matrix') {
      return (q.rows || []).filter(function (r) { return v[r.value] !== undefined; })
        .map(function (r) {
          var col = (q.columns || []).filter(function (c) { return c.value === v[r.value]; })[0];
          return self.t(r.text) + ': ' + (col ? self.t(col.text) : v[r.value]);
        });
    }

    if (q.type === 'multipletext') {
      return (q.items || []).filter(function (i) { return !Expr.isEmpty(v[i.name]); })
        .map(function (i) { return self.t(i.title) + ': ' + v[i.name]; });
    }

    // Ordenamiento: el orden ES la respuesta, así que se numera.
    if (q.type === 'ranking') {
      return v.map(function (val, i) { return (i + 1) + '. ' + label(val); });
    }

    if (q.type === 'file') {
      return v.map(function (f) { return f.name; });
    }

    if (q.type === 'signature') return 'Firmado';

    // Repetible: una línea por entrada, con sus campos respondidos.
    if (q.type === 'paneldynamic') {
      return (Array.isArray(v) ? v : []).map(function (entrada, i) {
        var partes = (q.templateElements || []).map(function (inner) {
          if (Expr.isEmpty(entrada[inner.id])) return null;
          var val = entrada[inner.id];
          if (Array.isArray(inner.choices)) {
            var c = inner.choices.filter(function (x) { return x.value === val; })[0];
            if (c) val = self.t(c.text);
          }
          return self.t(inner.title) + ': ' + (Array.isArray(val) ? val.join(', ') : val);
        }).filter(Boolean);
        return (i + 1) + ') ' + (partes.join(' · ') || 'sin datos');
      });
    }

    if (Array.isArray(v)) return v.map(label);
    if (Model.CHOICE_TYPES.indexOf(q.type) >= 0) return label(v);
    return v;
  };

  /**
   * Resultado completo y autodescriptivo de la respuesta.
   * Es la estructura que consume io/bigquery.js.
   */
  /** Delegado en Model, que es donde vive la regla (la usan también el
   *  exportador y el panel). */
  Runtime.prototype.tipoDeIndicador = function () {
    return Model.tipoDeIndicador(this.survey);
  };

  Runtime.prototype.result = function () {
    var self = this;
    var answers = [];
    var adjuntos = [];

    Model.eachQuestion(this.survey, function (q, page, pi, qi, panel) {
      if (Model.DISPLAY_TYPES.indexOf(q.type) >= 0) return;
      // Las del molde de un repetible no tienen valor propio: viajan dentro
      // del valor del grupo.
      if (panel && panel.type === 'paneldynamic') return;
      if (!self.isQuestionVisible(q) && !self.fixed[q.id]) return;
      if (self.values[q.id] === undefined) return;

      var raw = self.values[q.id];
      var pickedOther = Array.isArray(raw) ? raw.indexOf(OTHER) >= 0 : raw === OTHER;

      // Los adjuntos y la firma viajan aparte, no dentro de la respuesta:
      // un PNG en base64 dentro de cada fila haría inmanejable la tabla.
      var crudo = raw;
      if (q.type === 'file' && Array.isArray(raw)) {
        crudo = raw.map(function (f) {
          return { name: f.name, type: f.type, size: f.size };
        });
        adjuntos.push({ question_id: q.id, archivos: raw });
      }
      if (q.type === 'signature') {
        crudo = '(firma)';
        adjuntos.push({ question_id: q.id, firma: raw });
      }

      answers.push({
        page_id: page.id,
        question_id: q.id,
        question_title: self.t(q.title) || '',
        question_type: q.type,
        role: q.role || null,                    // score | driver | root_cause | context | ...
        value_raw: crudo,
        value_codes: (function () {
          // Matriz: "fila=columna", que es lo que permite agrupar en SQL.
          if (q.type === 'matrix' && raw && typeof raw === 'object') {
            return Object.keys(raw).map(function (f) { return f + '=' + raw[f]; });
          }
          // Varios textos: el contenido es libre, no hay categoría que contar.
          if (q.type === 'multipletext' && raw && typeof raw === 'object') {
            return Object.keys(raw);
          }
          // Archivos: el nombre, nunca el contenido.
          if (q.type === 'file' && Array.isArray(raw)) {
            return raw.map(function (f) { return f.name; });
          }
          if (q.type === 'signature') return ['firmado'];
          if (q.type === 'paneldynamic' && Array.isArray(raw)) {
            // Una entrada por elemento, con sus pares campo=valor: es lo que
            // permite contarlas en SQL sin desarmar un objeto anidado.
            return raw.map(function (e) {
              return Object.keys(e || {}).map(function (k) {
                return k + '=' + (Array.isArray(e[k]) ? e[k].join('|') : e[k]);
              }).join(';');
            });
          }

          return (Array.isArray(raw) ? raw : [raw]).map(function (rv) {
            // La opción "Otro" se codifica como tal: el texto libre va aparte,
            // para que no contamine los conteos por categoría.
            return rv === OTHER ? 'Otro' : String(rv);
          });
        })(),
        value_text: self.displayValue(q),
        other_text: pickedOther ? (self.values[q.id + '_otro'] || null) : null
      });
    });

    var finished = this.finishedAt || new Date();

    return {
      response_id: this.responseId,
      survey_id: this.survey.id,
      survey_version: this.survey.version,
      survey_title: this.survey.title,
      status: this.state,
      started_at: this.startedAt.toISOString(),
      finished_at: finished.toISOString(),
      duration_seconds: Math.round((finished - this.startedAt) / 1000),
      progress: this.state === 'completed' ? 100 : this.progress(),
      locale: this.locale,
      timed_out: !!this.timedOut,
      // Lo declara la encuesta, no su nombre: así una encuesta nueva que
      // mide NPS se clasifica bien sin tocar el exportador.
      settings_score_type: this.tipoDeIndicador(),
      score_quiz: this.survey.settings.scored ? this.score() : null,
      variables: util.clone(this.survey.variables),
      values: util.clone(this.values),
      answers: answers,
      // Fuera de `answers` a propósito: quien los necesite los sube a un
      // almacenamiento de archivos y guarda la URL, no el base64.
      attachments: adjuntos,
      client: {
        user_agent: global.navigator ? global.navigator.userAgent : null,
        language: global.navigator ? global.navigator.language : null,
        screen: global.screen ? (global.screen.width + 'x' + global.screen.height) : null,
        source: this.options.source || 'web'
      }
    };
  };

  SBQ.Runtime = Runtime;

})(typeof window !== 'undefined' ? window : globalThis);
