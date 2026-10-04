// An agent never writes secret material to disk. A file it wrote can end up
// committed, pasted into a log, or read back into a transcript.

import { fileTargets } from '../lib/commands.mjs';
import { baseName } from '../lib/paths.mjs';
import { deny } from '../lib/decision.mjs';

const SECRET = /^\.env(\..+)?$|\.(pem|key|p12|pfx)$|^id_(rsa|ecdsa|ed25519)$/i;
const TEMPLATE = /\.(example|sample|template)$/i;

export default {
  name: 'secrets-files',
  check(call) {
    for (const target of fileTargets(call)) {
      if (target.kind !== 'write') continue;
      const name = baseName(target.path);
      if (SECRET.test(name) && !TEMPLATE.test(name)) {
        return deny(`${name} holds secrets, and agents don't write those (via ${target.via}). Add the variable name to .env.example and let a human fill in the value.`);
      }
    }
    return null;
  },
};
