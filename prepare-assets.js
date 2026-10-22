'use strict';
const fs = require('node:fs');
const path = require('node:path');
const target = path.join(__dirname, 'public', 'invitation.webp');
fs.writeFileSync(target, Buffer.from(fs.readFileSync(target + '.b64', 'utf8'), 'base64'));
