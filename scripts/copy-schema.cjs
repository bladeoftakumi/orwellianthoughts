// Predeploy step: copy the shared data contract into the functions bundle,
// since Firebase only uploads the functions/ directory.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
fs.copyFileSync(path.join(root, 'schema.js'), path.join(root, 'functions', 'schema.mjs'));
console.log('Copied schema.js -> functions/schema.mjs');
