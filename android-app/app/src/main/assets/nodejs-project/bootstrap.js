const fs = require('node:fs');
const path = require('node:path');

const runtimeRoot = path.resolve(__dirname);
const dataRoot = path.join(runtimeRoot, 'data');

if (!fs.existsSync(dataRoot)) {
  fs.mkdirSync(dataRoot, { recursive: true });
}

process.chdir(runtimeRoot);

const appendArg = (flag, value) => {
  if (!process.argv.includes(flag)) {
    process.argv.push(flag, value);
  }
};

appendArg('--listen', '127.0.0.1');
appendArg('--port', '8000');
appendArg('--dataRoot', dataRoot);

// Run Luker server entry.
require(path.join(runtimeRoot, 'server.js'));
