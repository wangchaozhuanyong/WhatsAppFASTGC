// Serialized into the page's own world by Electron before website scripts run.
// This is a bounded privacy layer, not a replacement for a dedicated browser kernel.
function installSeatFingerprint(profile) {
  if (location.protocol !== 'https:' || location.hostname !== 'web.whatsapp.com') return { ok: false, error: 'WRONG_ORIGIN' };
  if (!profile || profile.v !== 1 || !Array.isArray(profile.seed) || profile.seed.length !== 4 || !profile.seed.every(n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)) throw new Error('INVALID_SEAT_ENVIRONMENT');
  const marker = Symbol.for('fastgc.seatPrivacy.v1');
  if (globalThis[marker]) return globalThis[marker];
  const seed = profile.seed.slice();
  const mix = (x, y, channel = 0) => {
    let a = (Math.imul(x + 1, seed[0] | 1) ^ Math.imul(y + 1, seed[1] | 1) ^ seed[2] ^ Math.imul(channel + 1, seed[3] | 1)) >>> 0;
    a = Math.imul(a ^ (a >>> 16), 0x45d9f3b) >>> 0;
    return (a ^ (a >>> 16)) >>> 0;
  };
  const noisePixels = (data, width, height, x = 0, y = 0, offset = 0) => {
    for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
      const index = offset + (row * width + column) * 4;
      if (index + 3 < data.length && mix(x + column, y + row) % 67 === 0) data[index] ^= 1;
    }
  };
  const features = { canvas: false, webgl: false, offlineAudio: false };
  const proto = globalThis.CanvasRenderingContext2D?.prototype;
  if (proto && globalThis.HTMLCanvasElement) {
    const read = proto.getImageData, write = proto.putImageData;
    const canvasProto = HTMLCanvasElement.prototype, encode = canvasProto.toDataURL, blob = canvasProto.toBlob;
    proto.getImageData = function (...args) {
      const image = read.apply(this, args);
      noisePixels(image.data, image.width, image.height, Number(args[0]) || 0, Number(args[1]) || 0);
      return image;
    };
    const cloneForEncoding = original => {
      if (!original.width || !original.height) return original;
      const clone = document.createElement('canvas');
      clone.width = original.width; clone.height = original.height;
      const context = clone.getContext('2d');
      context.drawImage(original, 0, 0);
      const pixels = read.call(context, 0, 0, clone.width, clone.height);
      noisePixels(pixels.data, pixels.width, pixels.height);
      write.call(context, pixels, 0, 0);
      return clone;
    };
    canvasProto.toDataURL = function (...args) { return encode.apply(cloneForEncoding(this), args); };
    canvasProto.toBlob = function (...args) { return blob.apply(cloneForEncoding(this), args); };
    features.canvas = true;
  }
  for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const glProto = globalThis[name]?.prototype;
    if (!glProto || !Object.prototype.hasOwnProperty.call(glProto, 'readPixels')) continue;
    const read = glProto.readPixels;
    glProto.readPixels = function (x, y, width, height, format, type, destination, offset = 0) {
      const result = read.apply(this, arguments);
      if (format === this.RGBA && type === this.UNSIGNED_BYTE && ArrayBuffer.isView(destination) && destination.BYTES_PER_ELEMENT === 1) noisePixels(destination, width, height, x, y, offset);
      return result;
    };
    features.webgl = true;
  }
  const offline = globalThis.OfflineAudioContext?.prototype;
  if (offline?.startRendering) {
    const render = offline.startRendering, changed = new WeakSet();
    const perturb = buffer => {
      if (!buffer || changed.has(buffer)) return buffer;
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const samples = buffer.getChannelData(channel);
        for (let index = 0; index < samples.length; index += 251) samples[index] += ((mix(index, channel, 1) & 255) - 127.5) * 1e-10;
      }
      changed.add(buffer); return buffer;
    };
    offline.startRendering = function (...args) { return render.apply(this, args).then(perturb); };
    features.offlineAudio = true;
  }
  const status = Object.freeze({ ok: true, version: 1, features: Object.freeze(features) });
  Object.defineProperty(globalThis, marker, { value: status });
  return status;
}
module.exports = { installSeatFingerprint };
