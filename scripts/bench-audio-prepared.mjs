import {mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {cpus, platform, arch, totalmem} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileHash, preparedKey, validatePreparedCache} from './audio-prepared-cache.mjs';

const [benchArg, prepareArg, fixturesArg, outArg, repeatsArg='3']=process.argv.slice(2);
if(!outArg) throw new Error('Usage: node scripts/bench-audio-prepared.mjs BENCH PREPARER DSP_FIXTURE_DIR NEW_OUT [REPEATS=3]');
const bench=resolve(benchArg), preparer=resolve(prepareArg), fixtures=resolve(fixturesArg), out=resolve(outArg);
const repeats=Number(repeatsArg);
if(!Number.isInteger(repeats) || repeats<1 || repeats>20) throw new Error('Invalid repetitions');
mkdirSync(out);
const inputs=Array.from({length:12},(_,i)=>({name:`${i}.wav`,sha256:fileHash(join(fixtures,`${i}.wav`)),bytes:statSync(join(fixtures,`${i}.wav`)).size}));
const importInputs=Array.from({length:4},(_,i)=>({name:`import-${i}.wav`,sha256:fileHash(join(fixtures,`import-${i}.wav`))}));
const git=args=>{const r=spawnSync('git',args,{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim();};
const metadata={mode:'prepared',repeats,started_at:new Date().toISOString(),cpu:cpus()[0]?.model,logical_cpus:cpus().length,
  platform:platform(),architecture:arch(),ram_bytes:totalmem(),commit:git(['rev-parse','HEAD']),dirty:git(['status','--short']),
  executable_sha256:fileHash(bench),preparer_sha256:fileHash(preparer),
  bungee_sha256:platform()==='win32'?fileHash(join(dirname(preparer),'bungee.dll')):null,
  inputs,import_inputs:importInputs,cache_mb:64,render_threads:1,fill_threads:1,decode_threads:1};
const env={...process.env,LIBRETRACKS_AUDIO_DIAG:'0',LIBRETRACKS_FILL_THREADS:'1',LIBRETRACKS_SOURCE_CACHE_MB:'64',
  LIBRETRACKS_SOURCE_READ_AHEAD_BLOCKS:'16',LIBRETRACKS_STREAMING_DECODE:'1',LIBRETRACKS_SOURCE_EAGER_BLOCKS:'64',
  LIBRETRACKS_DECODE_PLAYING_YIELD_MS:'6',LIBRETRACKS_DECODE_GATE:'0',LIBRETRACKS_CACHE_FLOAT:'0'};
const specs=new Map(), preparations=[];
for(const block of [128,512]) {
  const directory=join(out,`prepared-${block}`);
  console.log(`Preparing and verifying ${block}`);
  const r=spawnSync(preparer,[fixtures,directory,'12',String(block),'40','1.2','3'],{encoding:'utf8',env,timeout:300000});
  writeFileSync(join(out,`prepare-${block}.log`),(r.stdout??'')+(r.stderr??''));
  if(r.error || r.status!==0) throw new Error(r.error??r.stderr);
  const stats=JSON.parse(readFileSync(join(directory,'preparation.json'),'utf8'));
  if(stats.tracks!==12 || stats.block!==block || stats.samples_verified!==12*40*48000*2 || stats.output_bytes!==12*(44+40*48000*8))
    throw new Error('Incomplete preparation verification');
  const spec={inputs,block,warp_ratio:1.2,semitones:3,sample_rate:48000,channels:2,frames:40*48000,
    source_start_frame:0,timeline_start_frame:0,format:'WAV float32 LE',before_mix_controls:true,
    executable_sha256:metadata.executable_sha256,preparer_sha256:metadata.preparer_sha256,bungee_sha256:metadata.bungee_sha256,
    architecture:metadata.architecture,version:1};
  const outputs=inputs.map(({name})=>({name,bytes:statSync(join(directory,name)).size,sha256:fileHash(join(directory,name))}));
  const manifest={schema:1,key:preparedKey(spec),spec,outputs};
  validatePreparedCache(manifest,spec,directory);
  writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  for(const item of importInputs) copyFileSync(join(fixtures,item.name),join(directory,item.name));
  specs.set(block,{directory,spec,manifest});
  preparations.push({...stats,key:manifest.key,outputs});
}
const rows=[];
for(let repetition=0;repetition<repeats;repetition++) {
  const cases=[];
  for(const block of [128,512]) for(const imports of [0,4]) for(const prepared of [0,1]) cases.push({block,imports,prepared});
  if(repetition%2) cases.reverse();
  for(const c of cases) {
    const id=`r${repetition}-b${c.block}-i${c.imports}-p${c.prepared}`, entry=specs.get(c.block);
    console.log(id);
    const validationStart=performance.now();
    if(c.prepared) validatePreparedCache(entry.manifest,entry.spec,entry.directory);
    const validation_ms=c.prepared?performance.now()-validationStart:0;
    const cache=join(out,`${id}-cache`), json=join(out,`${id}.json`);
    mkdirSync(cache);
    const r=spawnSync(bench,[c.prepared?entry.directory:fixtures,json,'12',String(c.block),'512','1','0',String(c.imports),'1',c.prepared?'0':'3','1'],
      {encoding:'utf8',timeout:60000,env:{...env,LIBRETRACKS_CACHE_DIR:cache}});
    writeFileSync(join(out,`${id}.log`),(r.stdout??'')+(r.stderr??''));
    if(r.error || r.status!==0) throw new Error(r.error??r.stderr);
    const row=JSON.parse(readFileSync(json,'utf8'));
    if(row.rendered_tracks!==6144 || row.block!==c.block || row.blocks!==512 || row.dsp!==(c.prepared?0:3)
      || row.imports_completed!==c.imports || row.jump_applied_block<0 || row.missing_voice_blocks
      || (c.prepared ? row.active_voices_end!==0 || row.path_direct!==6144 : row.active_voices_end!==12 || row.path_stretched!==6144))
      throw new Error('Unexpected prepared/live workload');
    rows.push({repetition,prepared:c.prepared,validation_ms,...row});
    writeFileSync(join(out,'results.json'),JSON.stringify({metadata,preparations,rows},null,2)+'\n');
  }
}
console.log(`Saved ${rows.length} runs`);
