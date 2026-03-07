/* global chrome:false */
const JSZip = require('jszip');
const sanitize = require('sanitize-filename');
require('chrome-storage-promise');

const Data = require('modules/data');
const logger = require('util/logger')('background-sw');
const {validate} = require('modules/validate');
const filter = require('modules/filter');

const OFFSCREEN_DOCUMENT_PATH = 'html/render-offscreen.html';
const OFFSCREEN_PORT_NAME = 'offscreen-render';
const OFFSCREEN_CONNECT_TIMEOUT_MS = 15000;
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

const STORAGE_KEYS = {
  options: 'options',
  replayCounter: 'replay_counter'
};

const DOWNLOAD_REVOKE_FALLBACK_MS = 10 * 60 * 1000;
const MAX_DATA_URL_TEXT_BYTES = 1024 * 1024;
const pending_download_urls = new Map();
let rendering = false;
let offscreenPort = null;
let offscreenPortWaiters = [];
let renderRequestCounter = 0;
const renderRequests = new Map();
let offscreenDownloadRequestCounter = 0;
const offscreenDownloadRequests = new Map();

function sanitize_download_filename(filename, fallback = 'download.txt') {
  let value = sanitize(String(filename || '').trim());
  if (!value) {
    return fallback;
  }
  return value;
}

function is_validation_runtime_block(err) {
  if (!err || !err.message) return false;
  let msg = String(err.message).toLowerCase();
  return msg.includes('document is not defined')
    || msg.includes('unsafe-eval')
    || msg.includes('code generation from strings disallowed')
    || msg.includes('refused to evaluate a string')
    || msg.includes('error compiling schema');
}

async function validate_replay_safe(replay, strict = false) {
  try {
    return await validate(replay);
  } catch (err) {
    if (strict) {
      throw err;
    }
    if (is_validation_runtime_block(err)) {
      logger.warn(`Schema validation unavailable in service worker: ${err.message}`);
      return {
        replay: replay
      };
    }
    logger.warn(`Validation bypassed in service worker: ${err && err.message ? err.message : err}`);
    return {
      replay: replay
    };
  }
}

function getDefaultOptions() {
  return {
    fps:             60,
    duration:        30,
    hotkey_enabled:  true,
    hotkey:          47, // '/' key.
    custom_textures: false,
    canvas_width:    1280,
    canvas_height:   800,
    splats:          true,
    ui:              true,
    chat:            true,
    tile_previews:   true,
    spin:            true,
    record:          true // Recording enabled.
  };
}

async function ensureOptions() {
  let items = await chrome.storage.promise.local.get(STORAGE_KEYS.options);
  if (!items.options) {
    await chrome.storage.promise.local.set({
      [STORAGE_KEYS.options]: getDefaultOptions()
    });
    logger.info('Default options initialized.');
  }
}

const ready = Promise.all([
  Data.ready(),
  ensureOptions()
]).then(() => {
  logger.info('Service worker ready.');
});

const Metadata = {
  _key(id) {
    return `metadata:${id}`;
  },
  async get(id) {
    let key = this._key(id);
    let values = await chrome.storage.promise.local.get(key);
    let parsed = this.valid(values[key]);
    if (!parsed) {
      if (typeof values[key] !== 'undefined') {
        await this.remove(id);
      }
      return null;
    }
    return parsed;
  },
  async bulkGet(ids) {
    if (!ids.length) return new Map();
    let keys = ids.map(id => this._key(id));
    let values = await chrome.storage.promise.local.get(keys);
    let out = new Map();
    for (let id of ids) {
      out.set(id, this.valid(values[this._key(id)]));
    }
    return out;
  },
  async set(id, data) {
    await chrome.storage.promise.local.set({
      [this._key(id)]: data
    });
  },
  async remove(id) {
    await chrome.storage.promise.local.remove(this._key(id));
  },
  async removeMany(ids) {
    if (!ids.length) return;
    await chrome.storage.promise.local.remove(ids.map(id => this._key(id)));
  },
  async has(id) {
    let key = this._key(id);
    let values = await chrome.storage.promise.local.get(key);
    return typeof values[key] !== 'undefined';
  },
  async make(id, replay) {
    let metadata = extractMetaData(replay);
    await this.set(id, metadata);
    return metadata;
  },
  valid(data) {
    if (!data) return false;
    try {
      let parsed = typeof data === 'string' ? JSON.parse(data) : data;
      if (parsed.map) {
        return parsed;
      }
      return false;
    } catch (e) {
      return false;
    }
  }
};

const Movies = {
  async get(id) {
    let movie = await Data.db.table('savedMovies').get(id);
    if (typeof movie === 'undefined') {
      throw new Error(`Movie not found for replay: ${id}`);
    }
    return movie;
  },
  async has(id) {
    let movie = await Data.db.table('savedMovies').get(id);
    return typeof movie !== 'undefined';
  },
  async bulkHas(ids) {
    let result = new Map();
    await Promise.all(ids.map(async (id) => {
      result.set(id, await this.has(id));
    }));
    return result;
  },
  async save(id, movie) {
    await Data.db.table('savedMovies').put(movie, id);
  },
  async delete(id) {
    await Data.db.table('savedMovies').delete(id);
  },
  async deleteMany(ids) {
    if (!ids.length) return;
    await Data.db.table('savedMovies').bulkDelete(ids);
  }
};

function extractMetaData(positions) {
  var metadata = {
    redTeam: [],
    blueTeam: [],
    duration: 0,
    fps: 0,
    map: ''
  };

  let players = Object.keys(positions).filter(
    k => k.startsWith('player'));
  let me = players.find(k => positions[k].me === 'me');
  if (typeof me === 'undefined') {
    throw new Error('Replay did not contain the recording player.');
  }
  metadata.fps = positions[me].fps;
  metadata.map = positions[me].map;
  let start = Date.parse(positions.clock[0]);
  let end = Date.parse(positions.clock[positions.clock.length - 1]);
  metadata.duration = Math.round((end - start) / 1000);
  for (let key of players) {
    let player = positions[key];
    let name = player.name.find(n => n);
    let team = player.team[0];
    name = key === me ? `* ${name}`
                      : `  ${name}`;
    if (team === 1) {
      metadata.redTeam.push(name);
    } else {
      metadata.blueTeam.push(name);
    }
  }
  return metadata;
}

function make_replay_info(id, metadata) {
  return {
    id:        id,
    name:      id.replace(/DATE.*/, ''),
    recorded:  Number(id.replace('replays', '').replace(/.*DATE/, '')),
    rendered:  false,
    duration:  metadata.duration,
    map:       metadata.map,
    fps:       metadata.fps,
    red_team:  metadata.redTeam,
    blue_team: metadata.blueTeam
  };
}

function mustReplayExist(raw, id) {
  if (raw === undefined || raw === null) {
    throw new Error(`Replay not found: ${id}`);
  }
  return raw;
}

async function get_replay_data(id) {
  let raw = await Data.db.table('positions').get(id);
  mustReplayExist(raw, id);
  return JSON.parse(raw);
}

async function get_replay(id) {
  let data = await get_replay_data(id);
  let metadata = await Metadata.get(id);
  if (!metadata) {
    metadata = await Metadata.make(id, data);
  }
  let rendered = await Movies.has(id);
  let info = make_replay_info(id, metadata);
  info.rendered = rendered;
  return {
    info: info,
    data: data
  };
}

async function get_replay_info(id) {
  let metadata = await Metadata.get(id);
  let rendered = await Movies.has(id);
  if (!metadata) {
    let replay = await get_replay(id);
    return replay.info;
  }
  let info = make_replay_info(id, metadata);
  info.rendered = rendered;
  return info;
}

async function get_all_replays_info() {
  let ids = await Data.db.table('positions').toCollection().primaryKeys();
  let replay_info = [];
  let metadataById = await Metadata.bulkGet(ids);
  let pending = [];

  for (let i = 0; i < ids.length; i++) {
    let id = ids[i];
    let metadata = metadataById.get(id);
    if (!metadata) {
      replay_info.push(null);
      pending.push([id, i]);
    } else {
      replay_info.push(make_replay_info(id, metadata));
    }
  }

  await Promise.all(pending.map(async ([id, index]) => {
    let replay = await get_replay(id);
    replay_info[index] = replay.info;
  }));

  let rendered = await Movies.bulkHas(replay_info.map(info => info.id));
  for (let info of replay_info) {
    info.rendered = rendered.get(info.id);
  }

  return replay_info;
}

function get_replay_count() {
  return Data.db.table('positions').count();
}

async function delete_replay(id) {
  await Data.db.table('positions').delete(id);
  await Metadata.remove(id);
  await Movies.delete(id);
}

async function delete_replays(ids) {
  await Data.db.table('positions').bulkDelete(ids);
  await Metadata.removeMany(ids);
  await Movies.deleteMany(ids);
}

function set_replay(id, replay) {
  return Data.db.table('positions').put(JSON.stringify(replay), id);
}

async function save_replay(id, replay) {
  await set_replay(id, replay);
  let metadata = await Metadata.make(id, replay);
  return make_replay_info(id, metadata);
}

async function rename_replay(id, name) {
  let replay = await get_replay(id);
  if (name === replay.info.name) return replay.info;
  let newId = `${name}DATE${replay.info.recorded}`;
  await set_replay(newId, replay.data);
  await Metadata.make(newId, replay.data);
  if (newId !== id && await Movies.has(id)) {
    let movie = await Movies.get(id);
    await Movies.save(newId, movie);
  }
  if (newId !== id) {
    await delete_replay(id);
  }
  return get_replay_info(newId);
}

async function notify_tab(sender, message) {
  let tab = sender && sender.tab && sender.tab.id;
  if (typeof tab !== 'number') return;
  await new Promise((resolve) => {
    chrome.tabs.sendMessage(tab, message, () => {
      if (chrome.runtime.lastError) {
        logger.debug(`Skipping tab notification: ${chrome.runtime.lastError.message}`);
      }
      resolve();
    });
  });
}

function start_download(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: false,
      conflictAction: 'uniquify'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (typeof downloadId !== 'number') {
        reject(new Error('Download did not return a valid download id.'));
      } else {
        resolve(downloadId);
      }
    });
  });
}

async function download_blob(blob, filename) {
  let safeName = sanitize_download_filename(filename, 'download.bin');
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return download_blob_via_offscreen(blob, safeName);
  }
  let url = URL.createObjectURL(blob);
  try {
    let downloadId = await start_download(url, safeName);
    pending_download_urls.set(downloadId, url);
    setTimeout(() => {
      let pending = pending_download_urls.get(downloadId);
      if (!pending) return;
      URL.revokeObjectURL(pending);
      pending_download_urls.delete(downloadId);
    }, DOWNLOAD_REVOKE_FALLBACK_MS);
    return downloadId;
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

function download_text_data_url(filename, text) {
  let safeName = sanitize_download_filename(filename, 'replay.txt');
  let url = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  return start_download(url, safeName);
}

function download_text_file(filename, text) {
  let bytes = new TextEncoder().encode(text).byteLength;
  if (bytes <= MAX_DATA_URL_TEXT_BYTES) {
    return download_text_data_url(filename, text);
  }
  let blob = new Blob([text], {
    type: 'text/plain;charset=utf-8'
  });
  return download_blob(blob, filename);
}

async function download_replays(ids, sendProgress) {
  let total = ids.length;
  let i = 0;
  let zip = new JSZip();
  let size = 0;
  let max_size = 200 * 1024 * 1024;

  function progress(payload) {
    if (sendProgress) {
      sendProgress(payload);
    }
  }
  function send_start_zip_update() {
    progress({
      action: 'state',
      value: i === total ? 'zip:final'
                         : 'zip:intermediate'
    });
  }
  function send_end_zip_update() {
    progress({
      action: 'state',
      value: '!zip'
    });
  }

  let table = Data.db.table('positions');
  await Data.each_key(table, ids, async (cursor) => {
    i++;
    let item = cursor.value;
    if (!item) return;
    size += item.length;
    let filename = sanitize(cursor.key);
    zip.file(`${filename}.txt`, item);
    progress({
      action: 'progress',
      value: i / total
    });

    if (size > max_size) {
      size = 0;
      send_start_zip_update();
      let content = await zip.generateAsync({
        type: 'blob',
        compression: 'STORE'
      });
      await download_blob(content, 'raw_data.zip');
      send_end_zip_update();
      zip = new JSZip();
    }
  });

  if (!size) return;
  send_start_zip_update();
  let content = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE'
  });
  await download_blob(content, 'raw_data.zip');
  send_end_zip_update();
}

function serialize_error(error) {
  return {
    message: error && error.message ? error.message : String(error),
    name: error && error.name ? error.name : 'Error'
  };
}

function deserialize_error(data) {
  let error = new Error(data && data.message ? data.message : 'Unknown render error.');
  if (data && data.name) {
    error.name = data.name;
  }
  return error;
}

async function clean_rendered_replays() {
  let replayIds = new Set(
    await Data.db.table('positions').toCollection().primaryKeys()
  );
  let movieIds = await Data.db.table('savedMovies').toCollection().primaryKeys();
  let stale = movieIds.filter(id => !replayIds.has(id));
  if (stale.length) {
    await Movies.deleteMany(stale);
  }
}

async function ensure_offscreen_document() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) {
    let err = new Error('Offscreen API is not available in this Chrome version.');
    err.name = 'OffscreenUnavailable';
    throw err;
  }
  let offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  if (chrome.runtime.getContexts) {
    let contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length) {
      return;
    }
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ['BLOBS'],
      justification: 'Render highlight videos with a canvas in an offscreen document.'
    });
  } catch (err) {
    let message = err && err.message ? err.message : '';
    if (!message.includes('single offscreen document')) {
      throw err;
    }
  }
}

function resolve_offscreen_waiters(port) {
  if (!offscreenPortWaiters.length) return;
  for (let resolve of offscreenPortWaiters) {
    resolve(port);
  }
  offscreenPortWaiters = [];
}

function attach_offscreen_port(port) {
  offscreenPort = port;
  resolve_offscreen_waiters(port);
  port.onDisconnect.addListener(() => {
    offscreenPort = null;
    let err = new Error('Render worker disconnected unexpectedly.');
    for (let [requestId, request] of renderRequests.entries()) {
      request.reject(err);
      renderRequests.delete(requestId);
    }
    for (let [requestId, request] of offscreenDownloadRequests.entries()) {
      request.reject(err);
      offscreenDownloadRequests.delete(requestId);
    }
  });
  port.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'ready') {
      logger.info('Offscreen render worker connected.');
      return;
    }
    if (msg.type === 'download_url' && msg.requestId) {
      let request = offscreenDownloadRequests.get(msg.requestId);
      if (!request) return;
      let filename = sanitize_download_filename(msg.filename, 'download.bin');
      start_download(msg.url, filename).then((downloadId) => {
        offscreenDownloadRequests.delete(msg.requestId);
        request.resolve(downloadId);
      }).catch((err) => {
        offscreenDownloadRequests.delete(msg.requestId);
        request.reject(err);
      }).then(() => {
        try {
          port.postMessage({
            type: 'download_release',
            requestId: msg.requestId
          });
        } catch (err) {
          logger.warn(`Could not notify offscreen page to release download URL: ${err && err.message ? err.message : err}`);
        }
      });
      return;
    }
    if (msg.type === 'download_error' && msg.requestId) {
      let request = offscreenDownloadRequests.get(msg.requestId);
      if (!request) return;
      offscreenDownloadRequests.delete(msg.requestId);
      request.reject(deserialize_error(msg.error));
      return;
    }
    if (!msg.requestId) return;
    let request = renderRequests.get(msg.requestId);
    if (!request) return;
    if (msg.type === 'progress') {
      request.update(msg.progress);
    } else if (msg.type === 'complete') {
      renderRequests.delete(msg.requestId);
      request.resolve(msg.stats || {});
    } else if (msg.type === 'error') {
      renderRequests.delete(msg.requestId);
      request.reject(deserialize_error(msg.error));
    }
  });
}

function wait_for_offscreen_port(timeoutMs) {
  if (offscreenPort) {
    return Promise.resolve(offscreenPort);
  }
  return new Promise((resolve, reject) => {
    let timeout = setTimeout(() => {
      let err = new Error('Timed out waiting for offscreen render worker.');
      err.name = 'OffscreenTimeout';
      reject(err);
    }, timeoutMs);
    offscreenPortWaiters.push((value) => {
      clearTimeout(timeout);
      Promise.resolve(value).then(resolve, reject);
    });
  });
}

async function recreate_offscreen_document() {
  if (chrome.offscreen && chrome.offscreen.closeDocument) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (err) {
      logger.warn(`Could not close offscreen document during retry: ${err && err.message ? err.message : err}`);
    }
  }
  offscreenPort = null;
  await ensure_offscreen_document();
}

async function get_offscreen_port() {
  if (offscreenPort) {
    return offscreenPort;
  }
  await ensure_offscreen_document();
  try {
    return await wait_for_offscreen_port(OFFSCREEN_CONNECT_TIMEOUT_MS);
  } catch (firstErr) {
    if (firstErr && firstErr.name === 'OffscreenTimeout') {
      logger.warn('Offscreen worker connection timed out. Recreating offscreen document and retrying once.');
      await recreate_offscreen_document();
      return wait_for_offscreen_port(OFFSCREEN_CONNECT_TIMEOUT_MS);
    }
    throw firstErr;
  }
}

function download_blob_via_offscreen(blob, filename) {
  return get_offscreen_port().then((port) => {
    return new Promise((resolve, reject) => {
      let requestId = `download-${++offscreenDownloadRequestCounter}`;
      offscreenDownloadRequests.set(requestId, {
        resolve: resolve,
        reject: reject
      });
      try {
        port.postMessage({
          type: 'download_blob',
          requestId: requestId,
          filename: filename,
          blob: blob
        });
      } catch (err) {
        offscreenDownloadRequests.delete(requestId);
        reject(err);
      }
    });
  });
}

function download_movie_via_offscreen(id, filename) {
  return get_offscreen_port().then((port) => {
    return new Promise((resolve, reject) => {
      let requestId = `download-movie-${++offscreenDownloadRequestCounter}`;
      offscreenDownloadRequests.set(requestId, {
        resolve: resolve,
        reject: reject
      });
      try {
        port.postMessage({
          type: 'download_movie',
          requestId: requestId,
          id: id,
          filename: filename
        });
      } catch (err) {
        offscreenDownloadRequests.delete(requestId);
        reject(err);
      }
    });
  });
}

function render_replay_via_offscreen(id, update) {
  return Promise.all([
    get_offscreen_port(),
    get_render_config()
  ]).then(([port, renderConfig]) => {
    return new Promise((resolve, reject) => {
      let requestId = `render-${++renderRequestCounter}`;
      renderRequests.set(requestId, {
        resolve: resolve,
        reject: reject,
        update: update
      });
      try {
        port.postMessage({
          type: 'render',
          requestId: requestId,
          id: id,
          renderConfig: renderConfig
        });
      } catch (err) {
        renderRequests.delete(requestId);
        reject(err);
      }
    });
  });
}

async function get_render_config() {
  let {options, textures} = await chrome.storage.promise.local.get(['options', 'textures']);
  let merged_options = Object.assign({}, getDefaultOptions(), options || {});
  let customTextureUrls = {};
  if (merged_options.custom_textures && textures) {
    for (let name of TEXTURE_NAMES) {
      if (textures[name]) {
        customTextureUrls[name] = textures[name];
      }
    }
  }
  return {
    options: merged_options,
    customTextureUrls: customTextureUrls
  };
}

function cropReplayData(replay, start, end) {
  let length = replay.clock.length;
  if (start === 0 && end === length) {
    return replay;
  }

  let start_time = Date.parse(replay.clock[start]);
  let end_time = Date.parse(replay.clock[end]);

  function cropFrameArray(ary) {
    return ary.slice(start, end + 1);
  }

  function cropBombs(bombs) {
    let cutoff = 200;
    return bombs.filter((bomb) => {
      let time = Date.parse(bomb.time);
      return start_time - cutoff < time && time < end_time;
    });
  }

  function cropPlayer(player) {
    let name = cropFrameArray(player.name);
    let valid = name.some(v => v !== null);
    if (!valid) return null;

    let new_player = {
      auth: cropFrameArray(player.auth),
      bomb: cropFrameArray(player.bomb),
      dead: cropFrameArray(player.dead),
      degree: cropFrameArray(player.degree),
      draw: cropFrameArray(player.draw),
      flag: cropFrameArray(player.flag),
      flair: cropFrameArray(player.flair),
      fps: player.fps,
      grip: cropFrameArray(player.grip),
      map: player.map,
      me: player.me,
      name: name,
      tagpro: cropFrameArray(player.tagpro),
      team: cropFrameArray(player.team),
      x: cropFrameArray(player.x),
      y: cropFrameArray(player.y)
    };

    if (player.angle) {
      new_player.angle = cropFrameArray(player.angle);
    }
    return new_player;
  }

  function cropObject(object) {
    let x = cropFrameArray(object.x);
    let valid = x.some(v => v !== null);
    if (!valid) return null;

    return {
      draw: cropFrameArray(object.draw),
      id: object.id,
      type: object.type,
      x: cropFrameArray(object.x),
      y: cropFrameArray(object.y)
    };
  }

  function cropDynamicTile(tile) {
    return {
      x: tile.x,
      y: tile.y,
      value: cropFrameArray(tile.value)
    };
  }

  function cropSpawns(spawns) {
    return spawns.filter((spawn) => {
      let time = Date.parse(spawn.time);
      return start_time - spawn.w < time && time < end_time;
    });
  }

  function cropChats(chats) {
    let chat_duration = 30000;
    let clock = replay.clock.map(Date.parse);
    return chats.map((chat) => {
      if (!chat.removeAt) return false;
      let display_time = chat.removeAt - chat_duration;
      let remove_time = chat.removeAt;
      if (remove_time < start_time || end_time < display_time) return false;
      if (typeof chat.from !== 'number') return chat;
      if (chat.name) return chat;
      let player = replay[`player${chat.from}`];
      if (!player) return false;
      let reference_frame = clock.findIndex(
        (time) => display_time === Math.min(time, display_time));
      chat.name = typeof player.name === 'string' ? player.name
                                                  : player.name[reference_frame];
      chat.auth = player.auth[reference_frame];
      chat.team = player.team[reference_frame];
      return chat;
    }).filter(chat => chat);
  }

  function cropSplats(splats) {
    let splat_duration = 5000;
    return splats.filter((splat) => {
      let time = Date.parse(splat.time);
      if (end_time < time) return false;
      if (!splat.temp) return true;
      return !(time + splat_duration < start_time);
    });
  }

  function cropEvent(event) {
    if (event.name === 'spring-2017') {
      return {
        name: event.name,
        data: {
          egg_holder: cropFrameArray(event.data.egg_holder)
        }
      };
    }
  }

  let new_replay = {
    bombs: cropBombs(replay.bombs),
    chat: cropChats(replay.chat),
    clock: cropFrameArray(replay.clock),
    end: replay.end,
    gameEndsAt: replay.gameEndsAt,
    floorTiles: replay.floorTiles.map(cropDynamicTile),
    map: replay.map,
    objects: {},
    score: cropFrameArray(replay.score),
    spawns: cropSpawns(replay.spawns),
    splats: cropSplats(replay.splats),
    wallMap: replay.wallMap
  };

  for (let key in replay) {
    if (key.startsWith('player')) {
      let new_player = cropPlayer(replay[key]);
      if (new_player === null) continue;
      new_replay[key] = new_player;
    }
  }

  if ('objects' in replay) {
    for (let id in replay.objects) {
      let new_obj = cropObject(replay.objects[id]);
      if (new_obj === null) continue;
      new_replay.objects[id] = new_obj;
    }
  }

  if ('event' in replay) {
    new_replay.event = cropEvent(replay.event);
  }
  if ('tagproVersion' in replay) {
    new_replay.tagproVersion = replay.tagproVersion;
  }
  return new_replay;
}

function trimReplay(replay) {
  let data_start = replay.clock.findIndex(t => t !== 0);
  let data_end = replay.clock.length - 1;
  return cropReplayData(replay, data_start, data_end);
}

async function get_new_replay_name() {
  let prefix_length = 4;
  let max_val = Math.pow(10, prefix_length);
  let result = await chrome.storage.promise.local.get(STORAGE_KEYS.replayCounter);
  let current = Number(result[STORAGE_KEYS.replayCounter]);
  if (!Number.isFinite(current) || current < 1) {
    current = 1;
  } else {
    current = Math.max(current % max_val, 1);
  }
  let prefix = ('0'.repeat(prefix_length) + current).slice(-prefix_length);
  await chrome.storage.promise.local.set({
    [STORAGE_KEYS.replayCounter]: current + 1
  });
  let timestamp = Date.now();
  return `${prefix}_replay_${timestamp}`;
}

async function handle_message(message, sender) {
  let method = message && message.method;
  logger.info(`Received ${method}.`);
  await ready;

  if (method === 'track') {
    return {
      failed: false
    };
  }

  if (method === 'replay.get') {
    let {id} = message;
    try {
      let replay = await get_replay_data(id);
      return {
        failed: false,
        data: replay
      };
    } catch (err) {
      return {
        failed: true,
        reason: err.message
      };
    }
  }

  if (method === 'replay.crop') {
    let {id, start, end, new_name} = message;
    new_name += `DATE${Date.now()}`;
    try {
      let data = await get_replay_data(id);
      let cropped_data = cropReplayData(data, start, end);
      let replay_info = await save_replay(new_name, cropped_data);
      await notify_tab(sender, {
        method: 'replay.added',
        replay: replay_info
      });
      return {
        failed: false
      };
    } catch (err) {
      return {
        failed: true,
        reason: err.message
      };
    }
  }

  if (method === 'replay.crop_and_replace') {
    let {id, start, end, new_name} = message;
    try {
      let replay = await get_replay(id);
      let cropped_replay = cropReplayData(replay.data, start, end);
      new_name = `${new_name}DATE${replay.info.recorded}`;
      let replay_info = await save_replay(new_name, cropped_replay);
      if (replay_info.id === id) {
        await Movies.delete(id);
      } else {
        await delete_replay(id);
      }
      await notify_tab(sender, {
        method: 'replay.updated',
        id: id,
        replay: replay_info
      });
      return {
        failed: false
      };
    } catch (err) {
      return {
        failed: true,
        reason: err.message
      };
    }
  }

  if (method === 'replay.delete') {
    let {ids} = message;
    try {
      await delete_replays(ids);
      await notify_tab(sender, {
        method: 'replay.deleted',
        ids: ids
      });
      return {
        failed: false
      };
    } catch (err) {
      return {
        failed: true,
        reason: err.message
      };
    }
  }

  if (method === 'replay.import') {
    let {name, data} = message;
    name = name.replace(/\.txt$/, '');
    if (!name.includes('DATE') && !name.startsWith('replays')) {
      name += `DATE${Date.now()}`;
    }

    try {
      data = JSON.parse(data);
    } catch (e) {
      return {
        failed: true,
        reason: 'Replay is not valid JSON',
        name: 'ValidationError'
      };
    }

    try {
      let {replay} = await validate_replay_safe(data, true);
      replay = trimReplay(replay);
      let replay_info = await save_replay(name, replay);
      await Movies.delete(replay_info.id);
      await notify_tab(sender, {
        method: 'replay.added',
        replay: replay_info
      });
      return {
        failed: false
      };
    } catch (err) {
      return {
        failed: true,
        reason: err.name === 'ValidationError'
          ? err.message
          : `Validation error: ${err.message}`,
        name: 'ValidationError'
      };
    }
  }

  if (method === 'replay.save_record') {
    let {name, data} = message;
    if (!name) {
      name = await get_new_replay_name();
    }
    name = `${name}DATE${Date.now()}`;

    try {
      let replay = JSON.parse(data);
      // Validation in MV3 can fail due Ajv codegen/CSP runtime constraints.
      // Save recorder-originated data best-effort and rely on downstream handling.
      let trimmed = trimReplay(replay);
      await save_replay(name, trimmed);
      return {
        failed: false
      };
    } catch (err) {
      logger.error('Error saving replay: ', err);
      let fallback_downloaded = false;
      try {
        await download_text_file(`${name}.txt`, data);
        fallback_downloaded = true;
      } catch (downloadErr) {
        logger.error('Could not export failed replay payload: ', downloadErr);
      }
      return {
        failed: true,
        reason: err && err.message ? err.message : 'Failed to save highlight.',
        name: err && err.name ? err.name : 'Error',
        fallback_downloaded: fallback_downloaded
      };
    }
  }

  if (method === 'replay.list') {
    try {
      let query = message.query || '';
      let offset = Math.max(0, Number(message.offset) || 0);
      let limit = Math.max(1, Math.min(500, Number(message.limit) || 250));
      let info = await get_all_replays_info();
      info = await filter(info, query);
      info.sort((a, b) => b.recorded - a.recorded);
      let total = info.length;
      let page = info.slice(offset, offset + limit);
      return {
        replays: page,
        total: total,
        offset: offset,
        limit: limit,
        has_more: (offset + page.length) < total
      };
    } catch (err) {
      return {
        error: true,
        reason: err.message
      };
    }
  }

  if (method === 'replay.download') {
    let {id} = message;
    try {
      let data = await get_replay_data(id);
      await download_text_file(`${id}.txt`, JSON.stringify(data));
      return {
        failed: false
      };
    } catch (err) {
      return {
        failed: true,
        reason: err.message
      };
    }
  }

  if (method === 'replay.rename') {
    let {id, new_name} = message;
    try {
      let replay_info = await rename_replay(id, new_name);
      await notify_tab(sender, {
        method: 'replay.updated',
        id: id,
        replay: replay_info
      });
      return {
        failed: false
      };
    } catch (err) {
      return {
        failed: true,
        reason: err.message
      };
    }
  }

  if (method === 'movie.download') {
    let {id} = message;
    try {
      let info = await get_replay_info(id);
      let filename = sanitize_download_filename(`${info.name}.webm`, `${id}.webm`);
      await download_movie_via_offscreen(id, filename);
      return {
        failed: false
      };
    } catch (err) {
      return {
        failed: true,
        reason: err.message
      };
    }
  }

  if (method === 'cleanRenderedReplays') {
    await clean_rendered_replays();
    return {
      failed: false
    };
  }

  return {
    failed: true,
    reason: `Message type not recognized: ${method}`
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle_message(message, sender).then((response) => {
    sendResponse(response);
  }).catch((err) => {
    sendResponse({
      failed: true,
      reason: err.message
    });
  });
  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || typeof delta.id !== 'number') return;
  if (!delta.state) return;
  if (delta.state.current !== 'complete' && delta.state.current !== 'interrupted') {
    return;
  }
  let url = pending_download_urls.get(delta.id);
  if (!url) return;
  URL.revokeObjectURL(url);
  pending_download_urls.delete(delta.id);
});

chrome.runtime.onConnect.addListener((port) => {
  let name = port.name;
  logger.info(`Received port: ${name}`);

  if (name === OFFSCREEN_PORT_NAME) {
    attach_offscreen_port(port);
    return;
  }

  if (name === 'replay.render') {
    if (rendering) {
      let err = new Error('Already rendering.');
      err.name = 'AlreadyRendering';
      port.postMessage({ error: serialize_error(err) });
      port.disconnect();
      return;
    }
    rendering = true;
    let active = false;
    let tab = port.sender && port.sender.tab && port.sender.tab.id;
    port.onMessage.addListener((msg) => {
      if (active) return;
      active = true;
      let id = msg && msg.id;
      if (!id) {
        let err = new Error('No replay id provided for rendering.');
        err.name = 'InvalidRequest';
        port.postMessage({ error: serialize_error(err) });
        port.disconnect();
        rendering = false;
        return;
      }
      render_replay_via_offscreen(id, (progress) => {
        port.postMessage({ progress: progress });
      }).then(() => {
        return get_replay_info(id);
      }).then((replay_info) => {
        replay_info.rendered = true;
        if (typeof tab === 'number') {
          chrome.tabs.sendMessage(tab, {
            method: 'replay.updated',
            id: id,
            replay: replay_info
          }, () => {
            if (chrome.runtime.lastError) {
              logger.debug(`Could not send replay.updated to tab ${tab}: ${chrome.runtime.lastError.message}`);
            }
          });
        }
        port.postMessage({ done: true });
      }).catch((err) => {
        logger.error(`Rendering failed for ${id}: `, err);
        port.postMessage({ error: serialize_error(err) });
      }).then(() => {
        rendering = false;
        port.disconnect();
      });
    });
    port.onDisconnect.addListener(() => {
      if (!active) {
        rendering = false;
      }
    });
    return;
  }

  if (name === 'replay.download') {
    port.onMessage.addListener((msg) => {
      let ids = Array.isArray(msg && msg.ids) ? msg.ids : [];
      if (!ids.length) {
        port.postMessage({
          error: {
            name: 'InvalidRequest',
            message: 'No replay ids were provided for export.'
          }
        });
        port.disconnect();
        return;
      }
      download_replays(ids, (update) => {
        port.postMessage({ progress: update });
      }).catch((err) => {
        logger.error('Error downloading replays: ', err);
        port.postMessage({
          error: {
            name: err.name,
            message: err.message
          }
        });
      }).then(() => {
        port.disconnect();
      });
    });
    return;
  }

  port.postMessage({
    error: {
      name: 'UnknownPort',
      message: `Unsupported port: ${name}`
    }
  });
  port.disconnect();
});

chrome.runtime.onInstalled.addListener(() => {
  ensureOptions().catch((err) => {
    logger.error('Error initializing options: ', err);
  });
});

ready.then(() => {
  return get_replay_count();
}).then((n) => {
  logger.info(`Total replays loaded: ${n}`);
}).catch((err) => {
  logger.error('Error counting replays: ', err);
});
