/*!
 * surveyBQ — configuración del despliegue.
 *
 * Este archivo viaja CON la aplicación, y por eso es el único lugar donde
 * sirve poner el endpoint: quien escanea un QR llega con el navegador limpio,
 * así que una configuración guardada solo en localStorage no le llegaría
 * nunca y su respuesta se quedaría en su teléfono.
 *
 * Se puede sobrescribir por navegador desde la portada, lo que sirve para
 * probar contra otro endpoint sin tocar el despliegue.
 */
(function (global) {
  'use strict';
  var SBQ = global.SBQ || (global.SBQ = {});

  SBQ.config = {
    /* URL de la función que recibe las respuestas. Vacío = todo queda
       guardado en el navegador y se exporta a mano desde la portada. */
    endpoint: '',

    /* Se envía como cabecera X-SBQ-Origen. No es un secreto —viaja en el
       código de la página— pero deja fuera el ruido automatizado y permite
       distinguir el tráfico legítimo en los registros. */
    origen: 'surveybq-web',

    /* Reintentar la cola pendiente al recuperar la conexión. */
    reintentarAlVolver: true,

    /* Lectura del panel desde BigQuery. Si está vacío, el panel solo lee las
       respuestas locales o un archivo importado. Con URL, el panel pide una
       clave y muestra los datos en vivo (la clave se valida en el servidor,
       no vive acá). */
    panelEndpoint: '',

    /* Encuestas publicadas desde el editor. El respondedor consulta acá si hay
       una versión más nueva que la del archivo; el editor publica acá. */
    encuestasEndpoint: '',

    /*
     * Destino por encuesta.
     *
     * Cada cliente escribe en su propio proyecto: las respuestas de uno no
     * pueden terminar en la infraestructura de otro, porque la factura, los
     * permisos y un eventual borrado van juntos. Lo que no esté acá cae en
     * `endpoint`.
     */
    endpointPorEncuesta: {
      /* Vacío a propósito: hoy todas las encuestas usan el mismo endpoint y es
         el servidor el que manda cada una al dataset de su cliente. Esto queda
         para el día que un cliente necesite su propio proyecto. */
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
