// Builds the window/taskbar icon set from resources/icon.png.
//
//   node scripts/run-electron.cjs scripts/build-icons.cjs
//
// Runs inside Electron for its image scaler (no native image library needed).
// Writes resources/icon.ico — PNG-compressed entries, 16 to 256 px, which is
// what Windows reads for the title bar, taskbar and Alt+Tab — and a 512 px PNG
// for places that want a single bitmap.
const { app, nativeImage } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const resources = join(__dirname, '..', 'resources');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

app.whenReady().then(() => {
  const source = nativeImage.createFromBuffer(readFileSync(join(resources, 'icon.png')));
  if (source.isEmpty()) throw new Error('resources/icon.png could not be read');

  const pngs = SIZES.map((size) => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const headerSize = 6 + 16 * SIZES.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(SIZES.length, 4);
  let offset = headerSize;
  SIZES.forEach((size, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry); // 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2); // palette
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4); // planes
    header.writeUInt16LE(32, entry + 6); // bits per pixel
    header.writeUInt32LE(pngs[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += pngs[i].length;
  });
  writeFileSync(join(resources, 'icon.ico'), Buffer.concat([header, ...pngs]));
  writeFileSync(join(resources, 'icon-512.png'), source.resize({ width: 512, height: 512, quality: 'best' }).toPNG());
  console.log('icon.ico: ' + SIZES.join(', ') + ' px; icon-512.png');
  app.quit();
});
