import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileHash, preparedKey, validatePreparedCache} from './audio-prepared-cache.mjs';

test('prepared cache rejects changed inputs, DSP configuration and damaged output', () => {
  const directory=mkdtempSync(join(tmpdir(),'lt-prepared-'));
  try {
    const path=join(directory,'0.wav');
    writeFileSync(path,'original');
    const spec={inputs:[{sha256:'source-hash'}],warp_ratio:1.2,semitones:3,block:128,
      sample_rate:48000,preparer_sha256:'engine-hash',bungee_sha256:'bungee-hash'};
    const manifest={schema:1,key:preparedKey(spec),spec,outputs:[{name:'0.wav',bytes:8,sha256:fileHash(path)}]};
    validatePreparedCache(manifest,spec,directory);
    assert.equal(preparedKey(spec),preparedKey(Object.fromEntries(Object.entries(spec).reverse())));
    for(const [key,value] of Object.entries({inputs:[{sha256:'new-source'}],warp_ratio:1.3,semitones:4,
      block:512,sample_rate:44100,preparer_sha256:'new-engine',bungee_sha256:'new-bungee'}))
      assert.throws(()=>validatePreparedCache(manifest,{...spec,[key]:value},directory),/parameters changed/);
    assert.throws(()=>validatePreparedCache({...manifest,outputs:[]},spec,directory),/Incomplete/);
    writeFileSync(path,'corrupt!'); // Same length: hash must detect it.
    assert.throws(()=>validatePreparedCache(manifest,spec,directory),/changed or truncated/);
    writeFileSync(path,'short');
    assert.throws(()=>validatePreparedCache(manifest,spec,directory),/changed or truncated/);
  } finally {
    // Only the unique directory created by this test, under the OS temporary directory.
    rmSync(directory,{recursive:true,force:true});
  }
});
