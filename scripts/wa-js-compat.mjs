import { createHash } from 'node:crypto';
// Reviewed official WA-JS 4.7.2. Use its upstream collection and media adapters.
const REVIEWED_SHA256 = '97aca719c9ef8e618e7941425920451139def9bd70f5d8449c24864f406dfc85';
export function patchWaJsForCurrentWhatsApp(source) {
  const original = String(source);
  if (createHash('sha256').update(original).digest('hex') !== REVIEWED_SHA256) throw new Error('[wa-js-compat] review the installed WA-JS before packaging: expected reviewed 4.7.2 bundle');
  const before = 'c=u?u.msgProtobuf:s[1].id?s[2]:s[1];if(c.buttonsMessage)';
  const after = 'c=u?u.msgProtobuf:s[1]&&s[1].id?s[2]:s[1];if(!c||typeof c!=="object")return e(...s);if(c.buttonsMessage)';
  if (original.split(before).length !== 2) throw new Error('[wa-js-compat] review the installed WA-JS fanout wrapper');
  return original.replace(before, after);
}
