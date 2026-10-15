// Crash-safe file replacement. Writing a file in place can be cut short (power loss, kill -9, full disk) and leave a
// half-written or empty file — for state.json that used to mean "forget every open position". Here the new content
// goes to a temp file next to the target, is flushed to disk, and only then renamed over the target: the target is
// always either the complete old version or the complete new one.
const fs = require('fs');

function atomicWrite(file, data, mode) { // mode (optional, e.g. 0o600): permissions for the NEW file — used for files that hold secrets
  const tmp = `${file}.${process.pid}.tmp`;
  let fd;
  try {
    fd = mode === undefined ? fs.openSync(tmp, 'w') : fs.openSync(tmp, 'w', mode);
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    throw e; // the target file is untouched
  }
}

module.exports = { atomicWrite };
