import {openSync, closeSync, readSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';

// Chunked hashing keeps validation memory independent of source/cache length.
export function fileHash(path) {
  const fd=openSync(path,'r'), hash=createHash('sha256'), chunk=Buffer.alloc(256*1024);
  try { for (;;) { const n=readSync(fd,chunk,0,chunk.length,null); if(!n) break; hash.update(chunk.subarray(0,n)); } }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
function canonical(value) {
  if(Array.isArray(value)) return value.map(canonical);
  if(value && typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export function preparedKey(spec) {
  return createHash('sha256').update(JSON.stringify(canonical(spec))).digest('hex');
}
export function validatePreparedCache(manifest, expected, directory) {
  if(manifest.schema!==1 || manifest.key!==preparedKey(expected) || manifest.key!==preparedKey(manifest.spec))
    throw new Error('Prepared cache parameters changed; regenerate');
  if(manifest.outputs.length!==expected.inputs.length) throw new Error('Incomplete prepared cache');
  for(let i=0;i<manifest.outputs.length;i++) {
    const item=manifest.outputs[i];
    if(item.name!==`${i}.wav`) throw new Error('Unexpected prepared track mapping');
    const path=join(directory,item.name);
    if(statSync(path).size!==item.bytes || fileHash(path)!==item.sha256)
      throw new Error('Prepared audio changed or truncated; regenerate');
  }
}
