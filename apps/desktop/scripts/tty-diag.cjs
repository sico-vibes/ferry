// Prints what the bundled runtime (Ferry.exe with ELECTRON_RUN_AS_NODE=1) sees of the console.
// Used by cli-interactive-smoke.mjs to diagnose terminals where the interactive CLI cannot render.
const fs = require('node:fs');
const tty = require('node:tty');
const os = require('node:os');

const result = {
  os: `${os.type()} ${os.release()}`,
  stdinTTY: Boolean(process.stdin.isTTY),
  stdoutTTY: Boolean(process.stdout.isTTY),
  stderrTTY: Boolean(process.stderr.isTTY),
  columns: process.stdout.columns ?? null,
};
for (const [key, name] of [
  ['conin', '\\\\.\\CONIN$'],
  ['conout', '\\\\.\\CONOUT$'],
]) {
  try {
    const fd = fs.openSync(name, 'r+');
    const entry = { opened: true, isatty: tty.isatty(fd) };
    if (key === 'conin' && entry.isatty) {
      const stream = new tty.ReadStream(fd);
      try {
        stream.setRawMode(true);
        stream.setRawMode(false);
        entry.rawMode = true;
      } catch (error) {
        entry.rawMode = String(error.message);
      }
      stream.destroy();
    } else if (key === 'conout' && entry.isatty) {
      const stream = new tty.WriteStream(fd);
      entry.columns = stream.columns ?? null;
      stream.write('');
      fs.closeSync(fd);
    } else fs.closeSync(fd);
    result[key] = entry;
  } catch (error) {
    result[key] = { opened: false, error: String(error.code ?? error.message) };
  }
}
console.log(`FERRY_TTY_DIAG ${JSON.stringify(result)}`);
