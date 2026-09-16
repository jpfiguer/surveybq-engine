/*!
 * surveyBQ — expression.js
 * Mini lenguaje de expresiones para visibleIf / enableIf / requiredIf.
 *
 * Sintaxis (compatible en espíritu con SurveyJS, para que sea familiar):
 *   {pregunta} = 'valor'
 *   {pregunta} <> 'valor'      {pregunta} != 'valor'
 *   {nps} >= 9                 {csat} < 4
 *   {causas} contains 'Olor'   {causas} notcontains 'Olor'
 *   {nps} anyof [0,1,2,3,9,10] {causas} allof ['a','b']
 *   {comentario} empty         {comentario} notempty
 *   ({a} = 'x' and {b} > 2) or not {c} empty
 *
 * Se evalúa con un parser propio (sin eval ni new Function), por lo que es
 * seguro aunque la expresión venga de un usuario editando la encuesta.
 */
(function (global) {
  'use strict';

  var SBQ = global.SBQ || (global.SBQ = {});

  var COMPARISONS = {
    '=': 1, '==': 1, '<>': 1, '!=': 1, '>': 1, '<': 1, '>=': 1, '<=': 1,
    'contains': 1, 'notcontains': 1, 'anyof': 1, 'allof': 1
  };
  var UNARY = { 'empty': 1, 'notempty': 1 };

  function nums(args) {
    // Aplana listas: sum({causas}) debe sumar los elementos, no la lista.
    var out = [];
    args.forEach(function (a) {
      (Array.isArray(a) ? a : [a]).forEach(function (v) {
        var n = Number(v);
        if (!isNaN(n)) out.push(n);
      });
    });
    return out;
  }

  /** Funciones disponibles dentro de las expresiones. */
  var FUNCIONES = {
    round: function (a) {
      var d = a.length > 1 ? Number(a[1]) : 0;
      var f = Math.pow(10, d);
      return Math.round(Number(a[0]) * f) / f;
    },
    floor: function (a) { return Math.floor(Number(a[0])); },
    ceil:  function (a) { return Math.ceil(Number(a[0])); },
    abs:   function (a) { return Math.abs(Number(a[0])); },
    min:   function (a) { var n = nums(a); return n.length ? Math.min.apply(null, n) : null; },
    max:   function (a) { var n = nums(a); return n.length ? Math.max.apply(null, n) : null; },
    sum:   function (a) { return nums(a).reduce(function (s, x) { return s + x; }, 0); },
    avg:   function (a) {
      var n = nums(a);
      return n.length ? n.reduce(function (s, x) { return s + x; }, 0) / n.length : null;
    },
    len:   function (a) {
      var v = a[0];
      if (v === null || v === undefined) return 0;
      return Array.isArray(v) ? v.length : String(v).length;
    },
    count: function (a) {
      var v = a[0];
      if (v === null || v === undefined) return 0;
      return Array.isArray(v) ? v.length : 1;
    },
    'if':  function (a) { return a[0] ? a[1] : (a.length > 2 ? a[2] : null); },
    concat: function (a) {
      return a.map(function (v) {
        return Array.isArray(v) ? v.join(', ') : (v === null || v === undefined ? '' : String(v));
      }).join('');
    },
    upper: function (a) { return String(a[0] == null ? '' : a[0]).toUpperCase(); },
    lower: function (a) { return String(a[0] == null ? '' : a[0]).toLowerCase(); },
    today: function () { return new Date().toISOString().slice(0, 10); },
    year:  function () { return new Date().getFullYear(); },
    contains: function (a) {
      var l = a[0], r = a[1];
      if (typeof l === 'string') return l.indexOf(String(r)) >= 0;
      return (Array.isArray(l) ? l : []).some(function (x) { return String(x) === String(r); });
    }
  };

  // ---------------------------------------------------------------- tokenizer

  function tokenize(src) {
    var tokens = [];
    var i = 0, n = src.length;

    while (i < n) {
      var ch = src[i];

      if (/\s/.test(ch)) { i++; continue; }

      // {referencia a pregunta}
      if (ch === '{') {
        var end = src.indexOf('}', i);
        if (end < 0) throw new Error('Falta "}" en la expresión.');
        tokens.push({ t: 'ref', v: src.slice(i + 1, end).trim() });
        i = end + 1;
        continue;
      }

      // 'texto' o "texto"
      if (ch === "'" || ch === '"') {
        var quote = ch, buf = '';
        i++;
        while (i < n && src[i] !== quote) {
          if (src[i] === '\\' && i + 1 < n) { buf += src[i + 1]; i += 2; }
          else { buf += src[i]; i++; }
        }
        if (i >= n) throw new Error('Falta cerrar la comilla ' + quote + '.');
        i++;
        tokens.push({ t: 'lit', v: buf });
        continue;
      }

      // número. El signo NO se consume acá: el menos unario lo resuelve el
      // parser, para que "{a} - 3" no se lea como "{a}" seguido de "-3".
      if (/[0-9]/.test(ch)) {
        var num = '';
        while (i < n && /[0-9.]/.test(src[i])) { num += src[i]; i++; }
        tokens.push({ t: 'lit', v: parseFloat(num) });
        continue;
      }

      // operadores de 2 caracteres
      var two = src.substr(i, 2);
      if (two === '<>' || two === '!=' || two === '>=' || two === '<=' ||
          two === '==' || two === '&&' || two === '||') {
        tokens.push({ t: 'op', v: two === '&&' ? 'and' : two === '||' ? 'or' : two });
        i += 2;
        continue;
      }

      // operadores / puntuación de 1 carácter
      if ('=<>+-*/%'.indexOf(ch) >= 0) { tokens.push({ t: 'op', v: ch }); i++; continue; }
      if (ch === '!') { tokens.push({ t: 'op', v: 'not' }); i++; continue; }
      if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ',') {
        tokens.push({ t: 'punct', v: ch }); i++; continue;
      }

      // identificador / palabra clave
      if (/[A-Za-z_]/.test(ch)) {
        var word = '';
        while (i < n && /[A-Za-z0-9_]/.test(src[i])) { word += src[i]; i++; }
        var lower = word.toLowerCase();
        if (lower === 'true')  { tokens.push({ t: 'lit', v: true }); continue; }
        if (lower === 'false') { tokens.push({ t: 'lit', v: false }); continue; }
        if (lower === 'null' || lower === 'undefined') { tokens.push({ t: 'lit', v: null }); continue; }
        tokens.push({ t: 'op', v: lower });
        continue;
      }

      throw new Error('Carácter no reconocido en la expresión: "' + ch + '".');
    }

    return tokens;
  }

  // ------------------------------------------------------------------ parser

  function parse(src) {
    var tokens = tokenize(src);
    var pos = 0;

    function peek() { return tokens[pos]; }
    function next() { return tokens[pos++]; }
    function isOp(v) { var t = peek(); return t && t.t === 'op' && t.v === v; }
    function isPunct(v) { var t = peek(); return t && t.t === 'punct' && t.v === v; }
    function expect(v) {
      if (!isPunct(v)) throw new Error('Se esperaba "' + v + '" en la expresión.');
      return next();
    }

    function parseOr() {
      var left = parseAnd();
      while (isOp('or')) { next(); left = { k: 'or', l: left, r: parseAnd() }; }
      return left;
    }

    function parseAnd() {
      var left = parseNot();
      while (isOp('and')) { next(); left = { k: 'and', l: left, r: parseNot() }; }
      return left;
    }

    function parseNot() {
      if (isOp('not')) { next(); return { k: 'not', e: parseNot() }; }
      return parseComparison();
    }

    function parseComparison() {
      var left = parseAdditive();
      var t = peek();

      if (t && t.t === 'op' && UNARY[t.v]) {
        next();
        return { k: 'unary', op: t.v, e: left };
      }
      if (t && t.t === 'op' && COMPARISONS[t.v]) {
        next();
        return { k: 'cmp', op: t.v, l: left, r: parseAdditive() };
      }
      return left;
    }

    function parseAdditive() {
      var left = parseMultiplicative();
      while (isOp('+') || isOp('-')) {
        var op = next().v;
        left = { k: 'arit', op: op, l: left, r: parseMultiplicative() };
      }
      return left;
    }

    function parseMultiplicative() {
      var left = parseUnary();
      while (isOp('*') || isOp('/') || isOp('%')) {
        var op = next().v;
        left = { k: 'arit', op: op, l: left, r: parseUnary() };
      }
      return left;
    }

    function parseUnary() {
      if (isOp('-')) { next(); return { k: 'neg', e: parseUnary() }; }
      if (isOp('+')) { next(); return parseUnary(); }
      return parsePrimary();
    }

    function parseArray() {
      expect('[');
      var items = [];
      if (!isPunct(']')) {
        for (;;) {
          items.push(parseOperand());
          if (isPunct(',')) { next(); continue; }
          break;
        }
      }
      expect(']');
      return { k: 'array', items: items };
    }

    function parseOperand() {
      var t = peek();
      if (!t) throw new Error('Expresión incompleta.');
      if (isPunct('[')) return parseArray();
      if (t.t === 'ref') { next(); return { k: 'ref', name: t.v }; }
      if (t.t === 'lit') { next(); return { k: 'lit', value: t.v }; }
      throw new Error('Se esperaba un valor y se encontró "' + t.v + '".');
    }

    function parsePrimary() {
      if (isPunct('(')) {
        next();
        var inner = parseOr();
        expect(')');
        return inner;
      }

      // Llamada a función: un identificador seguido de paréntesis.
      var t = peek();
      if (t && t.t === 'op' && FUNCIONES[t.v] && tokens[pos + 1] &&
          tokens[pos + 1].t === 'punct' && tokens[pos + 1].v === '(') {
        var nombre = next().v;
        expect('(');
        var args = [];
        if (!isPunct(')')) {
          for (;;) {
            args.push(parseOr());
            if (isPunct(',')) { next(); continue; }
            break;
          }
        }
        expect(')');
        return { k: 'call', nombre: nombre, args: args };
      }

      return parseOperand();
    }

    var ast = parseOr();
    if (pos < tokens.length) {
      throw new Error('Sobra contenido en la expresión cerca de "' + tokens[pos].v + '".');
    }
    return ast;
  }

  // --------------------------------------------------------------- evaluador

  function isEmpty(v) {
    if (v === null || v === undefined || v === '') return true;
    if (Array.isArray(v)) return v.length === 0;
    if (typeof v === 'object') return Object.keys(v).length === 0;
    return false;
  }

  function asArray(v) {
    if (v === null || v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  }

  /** Compara con coerción suave: '5' y 5 se consideran iguales. */
  function looseEq(a, b) {
    if (a === b) return true;
    if (a == null || b == null) return false;
    if (typeof a === 'number' || typeof b === 'number') {
      var na = Number(a), nb = Number(b);
      if (!isNaN(na) && !isNaN(nb)) return na === nb;
    }
    return String(a) === String(b);
  }

  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined || v === '') return NaN;
    return Number(v);
  }

  function evalNode(node, values) {
    switch (node.k) {
      case 'lit':   return node.value;
      case 'ref':   return values ? values[node.name] : undefined;
      case 'array': return node.items.map(function (it) { return evalNode(it, values); });
      case 'and':   return !!evalNode(node.l, values) && !!evalNode(node.r, values);
      case 'or':    return !!evalNode(node.l, values) || !!evalNode(node.r, values);
      case 'not':   return !evalNode(node.e, values);

      case 'truthy': {
        var v = evalNode(node.e, values);
        return !isEmpty(v) && v !== false;
      }

      case 'neg': return -Number(evalNode(node.e, values));

      case 'call': {
        var fn = FUNCIONES[node.nombre];
        if (!fn) throw new Error('Función desconocida: ' + node.nombre);
        return fn(node.args.map(function (a) { return evalNode(a, values); }));
      }

      case 'arit': {
        var a = evalNode(node.l, values);
        var b = evalNode(node.r, values);
        // "+" concatena si alguno de los dos es texto no numérico.
        if (node.op === '+') {
          var na = Number(a), nb = Number(b);
          var numerico = a !== '' && b !== '' && !isNaN(na) && !isNaN(nb);
          return numerico ? na + nb : String(a == null ? '' : a) + String(b == null ? '' : b);
        }
        var x = Number(a), y = Number(b);
        if (node.op === '-') return x - y;
        if (node.op === '*') return x * y;
        if (node.op === '%') return y === 0 ? null : x % y;
        if (node.op === '/') return y === 0 ? null : x / y;   // sin división por cero
        throw new Error('Operador aritmético desconocido: ' + node.op);
      }

      case 'unary': {
        var uv = evalNode(node.e, values);
        return node.op === 'empty' ? isEmpty(uv) : !isEmpty(uv);
      }

      case 'cmp': {
        var l = evalNode(node.l, values);
        var r = evalNode(node.r, values);
        switch (node.op) {
          case '=': case '==':
            // Si el lado izquierdo es multi-respuesta, "=" se lee como "incluye".
            if (Array.isArray(l) && !Array.isArray(r)) {
              return l.some(function (x) { return looseEq(x, r); });
            }
            if (Array.isArray(l) && Array.isArray(r)) {
              return l.length === r.length && l.every(function (x, i) { return looseEq(x, r[i]); });
            }
            return looseEq(l, r);

          case '<>': case '!=':
            if (Array.isArray(l) && !Array.isArray(r)) {
              return !l.some(function (x) { return looseEq(x, r); });
            }
            return !looseEq(l, r);

          case '>':  return toNumber(l) >  toNumber(r);
          case '<':  return toNumber(l) <  toNumber(r);
          case '>=': return toNumber(l) >= toNumber(r);
          case '<=': return toNumber(l) <= toNumber(r);

          case 'contains':
            if (typeof l === 'string' && typeof r === 'string') return l.indexOf(r) >= 0;
            return asArray(l).some(function (x) { return looseEq(x, r); });

          case 'notcontains':
            if (typeof l === 'string' && typeof r === 'string') return l.indexOf(r) < 0;
            return !asArray(l).some(function (x) { return looseEq(x, r); });

          case 'anyof': {
            var la = asArray(l), ra = asArray(r);
            return la.some(function (x) { return ra.some(function (y) { return looseEq(x, y); }); });
          }

          case 'allof': {
            var la2 = asArray(l), ra2 = asArray(r);
            return ra2.every(function (y) { return la2.some(function (x) { return looseEq(x, y); }); });
          }
        }
        throw new Error('Operador no soportado: ' + node.op);
      }
    }
    throw new Error('Nodo de expresión desconocido: ' + node.k);
  }

  // ------------------------------------------------------------ API pública

  var cache = {};

  var Expression = {
    /** Compila (y cachea) una expresión. Devuelve el AST. */
    compile: function (src) {
      if (typeof src !== 'string') throw new Error('La expresión debe ser texto.');
      if (!cache[src]) cache[src] = parse(src);
      return cache[src];
    },

    /**
     * Evalúa una expresión contra un objeto de valores.
     * Una expresión vacía o nula se considera verdadera (sin condición).
     */
    evaluate: function (src, values) {
      if (src == null || src === '') return true;
      return !!evalNode(Expression.compile(src), values || {});
    },

    /**
     * Evalúa devolviendo el valor crudo, no un booleano. Es lo que usan las
     * preguntas calculadas: `round({csat} * 20)` debe dar 40, no true.
     */
    evaluateValue: function (src, values) {
      if (src == null || src === '') return null;
      return evalNode(Expression.compile(src), values || {});
    },

    /** Nombres de las funciones disponibles, para el editor. */
    functionNames: Object.keys(FUNCIONES).sort(),

    /**
     * Descompone una expresión en cláusulas simples, para poder editarla con
     * una interfaz en vez de a mano.
     *
     *   "{a} = 'x' and {b} > 2"
     *     -> { ok:true, union:'and', clausulas:[
     *            {ref:'a', op:'=', valor:'x'},
     *            {ref:'b', op:'>', valor:2} ] }
     *
     * Solo reconoce una cadena de comparaciones unidas todas por el mismo
     * conector. Cualquier cosa más enredada —paréntesis mezclando and/or,
     * negaciones, aritmética— devuelve ok:false, y el editor cae al modo
     * texto en vez de simplificar y romper la regla.
     */
    decompose: function (src) {
      if (src == null || src === '') return { ok: true, union: 'and', clausulas: [] };

      var ast;
      try { ast = Expression.compile(src); }
      catch (e) { return { ok: false, motivo: e.message }; }

      var union = null;
      var clausulas = [];
      var representable = true;

      function hoja(node) {
        // {pregunta} = valor
        if (node.k === 'cmp' && node.l && node.l.k === 'ref') {
          if (node.r.k === 'lit') {
            clausulas.push({ ref: node.l.name, op: node.op, valor: node.r.value });
            return;
          }
          if (node.r.k === 'array' && node.r.items.every(function (i) { return i.k === 'lit'; })) {
            clausulas.push({
              ref: node.l.name, op: node.op,
              valor: node.r.items.map(function (i) { return i.value; })
            });
            return;
          }
        }
        // {pregunta} empty / notempty
        if (node.k === 'unary' && node.e && node.e.k === 'ref') {
          clausulas.push({ ref: node.e.name, op: node.op, valor: null });
          return;
        }
        representable = false;
      }

      (function recorrer(node) {
        if (!representable) return;
        if (node.k === 'and' || node.k === 'or') {
          if (union && union !== node.k) { representable = false; return; }
          union = node.k;
          recorrer(node.l);
          recorrer(node.r);
          return;
        }
        hoja(node);
      })(ast);

      if (!representable) return { ok: false, motivo: 'La condición es demasiado compleja para el modo visual.' };
      return { ok: true, union: union || 'and', clausulas: clausulas };
    },

    /** Vuelve a armar la expresión desde las cláusulas del constructor. */
    compose: function (union, clausulas) {
      var partes = (clausulas || []).map(function (c) {
        if (!c || !c.ref || !c.op) return null;
        if (c.op === 'empty' || c.op === 'notempty') return '{' + c.ref + '} ' + c.op;

        var v = c.valor;
        var texto;
        if (Array.isArray(v)) {
          texto = '[' + v.map(function (x) {
            return typeof x === 'number' ? x : "'" + String(x).replace(/'/g, "\\'") + "'";
          }).join(', ') + ']';
        } else if (typeof v === 'number' || typeof v === 'boolean') {
          texto = String(v);
        } else {
          texto = "'" + String(v == null ? '' : v).replace(/'/g, "\\'") + "'";
        }
        return '{' + c.ref + '} ' + c.op + ' ' + texto;
      }).filter(Boolean);

      return partes.join(' ' + (union || 'and') + ' ');
    },

    /** Operadores que ofrece el constructor visual, con su etiqueta. */
    OPERADORES: [
      { op: '=',           texto: 'es igual a',        valor: 'uno' },
      { op: '<>',          texto: 'no es igual a',     valor: 'uno' },
      { op: 'anyof',       texto: 'es alguno de',      valor: 'varios' },
      { op: 'contains',    texto: 'incluye',           valor: 'uno' },
      { op: 'notcontains', texto: 'no incluye',        valor: 'uno' },
      { op: '>',           texto: 'es mayor que',      valor: 'numero' },
      { op: '>=',          texto: 'es mayor o igual a', valor: 'numero' },
      { op: '<',           texto: 'es menor que',      valor: 'numero' },
      { op: '<=',          texto: 'es menor o igual a', valor: 'numero' },
      { op: 'empty',       texto: 'está vacía',        valor: 'ninguno' },
      { op: 'notempty',    texto: 'tiene respuesta',   valor: 'ninguno' }
    ],

    /** Valida sintaxis. Devuelve {ok:true} o {ok:false, error:'...'} */
    validate: function (src) {
      if (src == null || src === '') return { ok: true };
      try { Expression.compile(src); return { ok: true }; }
      catch (e) { return { ok: false, error: e.message }; }
    },

    /** Nombres de pregunta referenciados por la expresión (para dependencias). */
    dependencies: function (src) {
      if (src == null || src === '') return [];
      var out = [];
      (function walk(node) {
        if (!node || typeof node !== 'object') return;
        if (node.k === 'ref') { if (out.indexOf(node.name) < 0) out.push(node.name); return; }
        ['l', 'r', 'e'].forEach(function (key) { if (node[key]) walk(node[key]); });
        if (node.items) node.items.forEach(walk);
      })(Expression.compile(src));
      return out;
    },

    isEmpty: isEmpty
  };

  SBQ.Expression = Expression;

})(typeof window !== 'undefined' ? window : globalThis);
