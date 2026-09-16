/*
 * surveyBQ — genera respuestas de prueba para el panel.
 *
 * Las distribuciones de acá son INVENTADAS: sirven para que el panel se vea
 * con datos plausibles al abrir el repositorio por primera vez. No provienen
 * de ninguna encuesta real ni de ningún cliente.
 *
 * Las respuestas se construyen con el motor de verdad (SBQ.Runtime), no
 * escribiendo JSON a mano, así que lo que sale tiene exactamente la misma
 * forma que una respuesta real: si el esquema cambia, esto cambia con él.
 *
 * Uso:  node tools/generar_muestra.js [cantidad] > datos/muestra-demo.json
 */
'use strict';
global.window = global;
var path = require('path');
var root = path.join(__dirname, '..');
['core/registry', 'core/expression', 'core/model', 'core/runtime']
  .forEach(function (f) { require(path.join(root, 'src', f + '.js')); });
require(path.join(root, 'surveys/demo-tipos.js'));

/** Elige de una lista de pares [valor, probabilidad]. */
function elegir(pares) {
  var r = Math.random(), acc = 0;
  for (var i = 0; i < pares.length; i++) {
    acc += pares[i][1];
    if (r <= acc) return pares[i][0];
  }
  return pares[pares.length - 1][0];
}
function az(a) { return a[Math.floor(Math.random() * a.length)]; }

/* Perfil inventado: mayoría satisfecha, cola de insatisfacción. */
var SATISFACCION  = [[5, .38], [4, .31], [3, .16], [2, .09], [1, .06]];
var RECOMENDACION = [[10, .21], [9, .19], [8, .16], [7, .12], [6, .08],
                     [5, .07], [4, .05], [3, .04], [2, .03], [1, .03], [0, .02]];
var ESFUERZO      = [[1, .08], [2, .12], [3, .18], [4, .22], [5, .18], [6, .13], [7, .09]];
var CANALES       = [['qr', .52], ['email', .28], ['wsp', .20]];
var ASPECTOS      = ['Limpieza', 'Seguridad', 'Precios', 'Atención', 'Variedad'];
var COMENTARIOS   = [
  'Todo bien, sin problemas.',
  'La atención podría ser más rápida en horario punta.',
  'Encontré lo que buscaba sin dar vueltas.',
  'Me costó ubicar la sección que necesitaba.',
  'Muy buena disposición del personal.',
  'Los precios me parecieron altos para lo que ofrecen.'
];

var cantidad = Number(process.argv[2]) || 600;
var sv = SBQ.surveys['demo-tipos'];
var salida = [];
var inicio = new Date('2026-04-01T10:00:00Z').getTime();
var fin    = new Date('2026-08-31T20:00:00Z').getTime();

for (var i = 0; i < cantidad; i++) {
  var rt = new SBQ.Runtime(sv, { source: 'muestra' });

  var sat = elegir(SATISFACCION);
  rt.setValue('satisfaccion', sat);
  rt.setValue('recomendacion', elegir(RECOMENDACION));
  rt.setValue('esfuerzo', elegir(ESFUERZO));

  if (Math.random() < 0.88) rt.setValue('canal_preferido', elegir(CANALES));

  if (Math.random() < 0.82) {
    var cuantos = 1 + Math.floor(Math.random() * 3);           // entre 1 y 3
    var mezcla = ASPECTOS.slice().sort(function () { return Math.random() - 0.5; });
    rt.setValue('aspectos', mezcla.slice(0, cuantos));
  }

  /* Quien quedó insatisfecho comenta bastante más que el resto. */
  var probComentario = sat <= 2 ? 0.66 : 0.18;
  if (Math.random() < probComentario) rt.setValue('que_paso', az(COMENTARIOS));

  if (Math.random() < 0.74) rt.setValue('conforme', Math.random() < 0.8);

  var t = new Date(inicio + Math.random() * (fin - inicio));
  rt.startedAt = t;
  rt.finishedAt = new Date(t.getTime() + (30 + Math.random() * 150) * 1000);

  /* ~11% abandona a medio camino: sin esto el panel se ve irrealmente limpio. */
  var abandona = Math.random() < 0.11;
  rt.state = abandona ? 'running' : 'completed';
  var res = rt.result();
  if (abandona) { res.status = 'partial'; res.progress = 35 + Math.floor(Math.random() * 45); }
  salida.push(res);
}

salida.sort(function (a, b) { return a.started_at < b.started_at ? -1 : 1; });
process.stdout.write(JSON.stringify(salida));
