/* global chrome:false */
const loadImage = require('image-promise');

const Data = require('modules/data');
const get_renderer = require('modules/renderer');
const renderVideo = require('modules/make-video');
const logger = require('util/logger')('render-offscreen');
const OFFSCREEN_PORT_NAME = 'offscreen-render';
const TEXTURE_NAMES = [
  'flair',
  'portal',
  'speedpad',
  'speedpadblue',
  'speedpadred',
  'splats',
  'tiles',
  'egg'
];

let canvas = null;
let rendering = false;
let servicePort = null;
const pending_download_urls = new Map();

const ready = Data.ready().then(() => {
  logger.info('Offscreen renderer ready.');
});

function serialize_error(error) {
  return {
    message: error && error.message ? error.message : String(error),
    name: error && error.name ? error.name : 'Error'
  };
}

function post_to_service(message) {
  if (!servicePort) {
    throw new Error('Render service port is disconnected.');
  }
  servicePort.postMessage(message);
}

function coerce_blob(value, mime = 'application/octet-stream') {
  if (value instanceof Blob) {
    return value;
  }
  if (value && value.output instanceof Blob) {
    return value.output;
  }
  if (value && value.blob instanceof Blob) {
    return value.blob;
  }
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return new Blob([Uint8Array.from(value.data)], {type: mime});
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return new Blob([value], {type: mime});
  }
  if (typeof value === 'string') {
    return new Blob([value], {type: mime});
  }
  throw new Error('Download payload is not a valid blob-like value.');
}

function normalize_frame_duration(rawDuration, nominalDuration) {
  if (!Number.isFinite(rawDuration) || rawDuration <= 0) {
    return Math.max(1, Math.round(nominalDuration));
  }
  let steps = Math.max(1, Math.round(rawDuration / nominalDuration));
  let normalized = steps * nominalDuration;
  return Math.max(1, Math.round(normalized));
}

function* frame_source(renderer) {
  let replay = renderer.replay;
  let me = Object.keys(replay).find(k => replay[k].me == 'me');
  let fps = replay[me].fps;
  let frames = replay.clock.length;
  let end = frames - 1;
  let frame = 0;
  let nominal = 1000 / fps;
  let frame_time = Date.parse(replay.clock[frame]);
  while (frame < end) {
    let next_frame_time = Date.parse(replay.clock[frame + 1]);
    let raw_duration = next_frame_time - frame_time;
    let frame_duration = normalize_frame_duration(raw_duration, nominal);
    renderer.draw(frame);
    yield renderer.toBlob('image/webp', 0.8)
    .then((blob) => ({frame: blob, duration: frame_duration}));
    frame_time = next_frame_time;
    frame++;
  }
  renderer.draw(frame);
  yield renderer.toBlob('image/webp', 0.8)
  .then((blob) => ({frame: blob, duration: Math.round(nominal)}));
}

async function get_replay_data(id) {
  let raw = await Data.db.table('positions').get(id);
  if (raw === undefined || raw === null) {
    throw new Error(`Replay not found: ${id}`);
  }
  return JSON.parse(raw);
}

async function save_movie(id, movie) {
  await Data.db.table('savedMovies').put(movie, id);
}

async function ensure_canvas() {
  if (canvas) {
    return canvas;
  }
  canvas = document.createElement('canvas');
  canvas.id = 'tpr-offscreen-canvas';
  canvas.width = 1280;
  canvas.height = 800;
  canvas.style.display = 'none';
  document.body.appendChild(canvas);
  return canvas;
}

function get_default_options() {
  return {
    fps:             60,
    duration:        30,
    hotkey_enabled:  true,
    hotkey:          47,
    custom_textures: false,
    canvas_width:    1280,
    canvas_height:   800,
    splats:          true,
    ui:              true,
    chat:            true,
    tile_previews:   true,
    spin:            true,
    record:          true
  };
}

async function load_textures(renderConfig) {
  let custom = renderConfig && renderConfig.customTextureUrls
    ? renderConfig.customTextureUrls
    : {};
  let urls = TEXTURE_NAMES.map((name) => {
    if (custom[name]) {
      return custom[name];
    }
    return chrome.runtime.getURL(`images/${name}.png`);
  });
  let images = await loadImage(urls);
  let textures = {};
  for (let i = 0; i < TEXTURE_NAMES.length; i++) {
    textures[TEXTURE_NAMES[i]] = images[i];
  }

  return textures;
}

async function render_replay(id, renderConfig, update) {
  let replay_data = await get_replay_data(id);
  let replay = replay_data;
  let options = Object.assign(
    {},
    get_default_options(),
    renderConfig && renderConfig.options ? renderConfig.options : {}
  );
  let textures = await load_textures(renderConfig);
  options.textures = textures;
  let can = await ensure_canvas();
  let renderer = await get_renderer(can, replay, options);
  let frames = renderer.replay.clock.length;
  let notification_freq = 0.05;
  let portions_complete = 0;
  let {output, stats} = await renderVideo(frame_source(renderer))
  .progress((progress) => {
    let amountCompleted = progress / frames;
    if (Math.floor(amountCompleted / notification_freq) != portions_complete) {
      portions_complete++;
      update(amountCompleted);
    }
  });
  await save_movie(id, output);
  return stats;
}

function handle_render_request(msg) {
  if (!msg || msg.type !== 'render' || !msg.requestId) return;
  if (rendering) {
    let err = new Error('Already rendering.');
    err.name = 'AlreadyRendering';
    post_to_service({
      type: 'error',
      requestId: msg.requestId,
      error: serialize_error(err)
    });
    return;
  }
  rendering = true;
  Promise.resolve()
  .then(() => ready)
  .then(() => render_replay(msg.id, msg.renderConfig, (progress) => {
    post_to_service({
      type: 'progress',
      requestId: msg.requestId,
      progress: progress
    });
  }))
  .then((stats) => {
    post_to_service({
      type: 'complete',
      requestId: msg.requestId,
      stats: stats
    });
  })
  .catch((err) => {
    logger.error(`Render failed for ${msg.id}: `, err);
    try {
      post_to_service({
        type: 'error',
        requestId: msg.requestId,
        error: serialize_error(err)
      });
    } catch (portErr) {
      logger.error('Could not report render error to service worker: ', portErr);
    }
  })
  .then(() => {
    rendering = false;
  });
}

function handle_download_request(msg) {
  if (!msg || msg.type !== 'download_blob' || !msg.requestId) return;
  let requestId = msg.requestId;
  Promise.resolve().then(() => {
    if (!msg.blob) {
      throw new Error('No blob provided for download.');
    }
    let blob = coerce_blob(msg.blob);
    let url = URL.createObjectURL(blob);
    pending_download_urls.set(requestId, url);
    setTimeout(() => {
      let pending = pending_download_urls.get(requestId);
      if (!pending) return;
      URL.revokeObjectURL(pending);
      pending_download_urls.delete(requestId);
    }, 10 * 60 * 1000);
    post_to_service({
      type: 'download_url',
      requestId: requestId,
      filename: msg.filename || 'download.bin',
      url: url
    });
  }).catch((err) => {
    let pending = pending_download_urls.get(requestId);
    if (pending) {
      URL.revokeObjectURL(pending);
      pending_download_urls.delete(requestId);
    }
    try {
      post_to_service({
        type: 'download_error',
        requestId: requestId,
        error: serialize_error(err)
      });
    } catch (portErr) {
      logger.error('Could not report offscreen download error: ', portErr);
    }
  });
}

function handle_download_movie_request(msg) {
  if (!msg || msg.type !== 'download_movie' || !msg.requestId) return;
  let requestId = msg.requestId;
  Promise.resolve().then(() => {
    if (!msg.id) {
      throw new Error('No movie id provided for download.');
    }
    return Data.db.table('savedMovies').get(msg.id);
  }).then((movie) => {
    if (typeof movie === 'undefined') {
      throw new Error(`Movie not found for replay: ${msg.id}`);
    }
    let blob = coerce_blob(movie, 'video/webm');
    let url = URL.createObjectURL(blob);
    pending_download_urls.set(requestId, url);
    setTimeout(() => {
      let pending = pending_download_urls.get(requestId);
      if (!pending) return;
      URL.revokeObjectURL(pending);
      pending_download_urls.delete(requestId);
    }, 10 * 60 * 1000);
    post_to_service({
      type: 'download_url',
      requestId: requestId,
      filename: msg.filename || `${msg.id}.webm`,
      url: url
    });
  }).catch((err) => {
    let pending = pending_download_urls.get(requestId);
    if (pending) {
      URL.revokeObjectURL(pending);
      pending_download_urls.delete(requestId);
    }
    try {
      post_to_service({
        type: 'download_error',
        requestId: requestId,
        error: serialize_error(err)
      });
    } catch (portErr) {
      logger.error('Could not report movie download error: ', portErr);
    }
  });
}

function handle_port_message(msg) {
  if (!msg || !msg.type) return;
  if (msg.type === 'render') {
    handle_render_request(msg);
    return;
  }
  if (msg.type === 'download_blob') {
    handle_download_request(msg);
    return;
  }
  if (msg.type === 'download_movie') {
    handle_download_movie_request(msg);
    return;
  }
  if (msg.type === 'download_release' && msg.requestId) {
    let pending = pending_download_urls.get(msg.requestId);
    if (!pending) return;
    URL.revokeObjectURL(pending);
    pending_download_urls.delete(msg.requestId);
  }
}

function connect_service_port() {
  servicePort = chrome.runtime.connect({name: OFFSCREEN_PORT_NAME});
  logger.info('Render service port connected.');
  servicePort.postMessage({type: 'ready'});
  servicePort.onMessage.addListener(handle_port_message);
  servicePort.onDisconnect.addListener(() => {
    servicePort = null;
    setTimeout(connect_service_port, 200);
  });
}

connect_service_port();
