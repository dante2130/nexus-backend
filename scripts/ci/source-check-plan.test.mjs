// Focused regression for the auditable backend source-check plan. It only
// builds and inspects plans; it never runs cargo, a compiler or the native
// regression, and it never starts the service or a real account.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  MODES,SOURCE_ONLY_MARKER,CONTRACT_DIRECTORY,NATIVE_REGRESSION,assertContractPath,
  enumerateContractTests,resolveMode,readEventContext,buildPlan,assertNoCompilation,planSummary,
} from './source-check-plan.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const modulePath=path.join(repository,CONTRACT_DIRECTORY,'source-check-plan.mjs');
const workflowPath=path.join(repository,'.github','workflows','checks.yml');

async function independentContractFiles(){
  const files=[];
  for(const entry of await fs.readdir(path.join(repository,...CONTRACT_DIRECTORY.split('/')),{withFileTypes:true})){
    if(entry.isFile()&&entry.name.endsWith('.test.mjs'))files.push(CONTRACT_DIRECTORY+'/'+entry.name);
  }
  return files.sort();
}

async function workflowText(){return fs.readFile(workflowPath,'utf8');}

// Minimal step scan for the checks job: a step starts at six spaces and its
// keys are indented eight spaces.
function stepsOf(text){
  const lines=text.split('\n');
  const start=lines.findIndex(line=>/^    steps:\s*$/.test(line));
  assert.ok(start>=0,'checks.yml must define job steps');
  const steps=[];
  let current=null;
  for(const line of lines.slice(start+1)){
    if(/^ {6}- /.test(line)){
      if(current)steps.push(current);
      current={name:null,text:line+'\n'};
      const name=/name:\s*(.+)$/.exec(line);
      if(name)current.name=name[1].trim();
      continue;
    }
    if(!current)continue;
    if(line.trim()&&!/^ {6,}/.test(line)){steps.push(current);current=null;break;}
    current.text+=line+'\n';
    const name=/^\s+name:\s*(.+)$/.exec(line);
    if(name)current.name=name[1].trim();
  }
  if(current)steps.push(current);
  return steps;
}

function stepNamed(steps,name){
  const step=steps.find(candidate=>candidate.name===name);
  assert.ok(step,'missing workflow step: '+name);
  return step;
}

const FULL_GUARD=/^ {8}if: steps\.mode\.outputs\.mode == 'full'$/m;

test('the default full plan selects every noncompiling contract test and the native regression',async()=>{
  const expected=await independentContractFiles();
  const plan=await buildPlan({mode:'full'});
  assert.equal(plan.mode,'full');
  assert.deepEqual([...plan.contracts],expected);
  assert.equal(plan.nativeRegression,NATIVE_REGRESSION);
  assert.deepEqual([...plan.skippedNative],[]);
  assert.deepEqual([...await enumerateContractTests()],expected);
  for(const file of plan.contracts)await fs.access(path.join(repository,...file.split('/')));
  await assertNoCompilation(plan.contracts);
  const summary=planSummary(plan).join('\n');
  assert.match(summary,/Source-check mode: full/);
  assert.match(summary,/Native regression selected for the following step: scripts\/test-backend\.mjs/);
  assert.ok(!summary.includes('NOT run'));
});

test('explicit source-only mode runs the same contracts and skips only the native cargo regression',async()=>{
  const expected=await independentContractFiles();
  const plan=await buildPlan({mode:'source-only'});
  assert.equal(plan.mode,'source-only');
  assert.deepEqual([...plan.contracts],expected);
  assert.deepEqual([...plan.skippedNative],[NATIVE_REGRESSION]);
  const summary=planSummary(plan).join('\n');
  assert.match(summary,/Source-check mode: source-only/);
  assert.match(summary,/Native regression NOT run and NOT passed: scripts\/test-backend\.mjs/);
  assert.match(summary,/Rust toolchain, native test libraries, Rust cache and account-free cargo regression tests/);
  assert.match(summary,/Native regression coverage remains unverified/);
  assert.ok(!summary.includes('Native regression selected'));
});

test('push and pull request markers keep the existing exact [source-only] semantics',()=>{
  assert.equal(SOURCE_ONLY_MARKER,'[source-only]');
  const marked='backend: dependency pins\n\n[source-only]\n';
  assert.equal(resolveMode({eventName:'push',headCommitMessage:marked}),'source-only');
  assert.equal(resolveMode({eventName:'push',headCommitMessage:'backend: dependency pins'}),'full');
  assert.equal(resolveMode({eventName:'pull_request',pullRequestTitle:'backend: [source-only] dependency pins'}),'source-only');
  assert.equal(resolveMode({eventName:'pull_request',pullRequestTitle:'backend: dependency pins'}),'full');
  // A push reads only its HEAD commit message; a pull request reads only its title.
  assert.equal(resolveMode({eventName:'push',headCommitMessage:'plain',pullRequestTitle:marked}),'full');
  assert.equal(resolveMode({eventName:'pull_request',pullRequestTitle:'plain',headCommitMessage:marked}),'full');
  // Missing, unknown or near-miss values keep the normal full plan.
  assert.equal(resolveMode(),'full');
  assert.equal(resolveMode({}),'full');
  assert.equal(resolveMode({eventName:'push'}),'full');
  assert.equal(resolveMode({eventName:'pull_request'}),'full');
  assert.equal(resolveMode({eventName:'workflow_dispatch',headCommitMessage:marked,pullRequestTitle:marked}),'full');
  assert.equal(resolveMode({eventName:'push',headCommitMessage:'[Source-Only]'}),'full');
  assert.equal(resolveMode({eventName:'push',headCommitMessage:'[source-only'}),'full');
  assert.equal(resolveMode({eventName:'push',headCommitMessage:'source-only]'}),'full');
});

test('GITHUB_EVENT_PATH is parsed safely and malformed context fails closed to full',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'backend-source-check-event-'));
  const write=async(name,value)=>{
    const file=path.join(root,name);
    await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));
    return file;
  };
  try{
    const markedPush=await write('push.json',{head_commit:{message:'backend: pins\n\n[source-only]'}});
    assert.equal(resolveMode(await readEventContext({eventName:'push',eventPath:markedPush})),'source-only');
    const plainPush=await write('plain-push.json',{head_commit:{message:'backend: pins'}});
    assert.equal(resolveMode(await readEventContext({eventName:'push',eventPath:plainPush})),'full');
    const markedPr=await write('pr.json',{pull_request:{title:'backend: [source-only] pins'}});
    assert.equal(resolveMode(await readEventContext({eventName:'pull_request',eventPath:markedPr})),'source-only');
    const plainPr=await write('plain-pr.json',{pull_request:{title:'backend: pins'}});
    assert.equal(resolveMode(await readEventContext({eventName:'pull_request',eventPath:plainPr})),'full');
    // Mixed payloads keep the event-specific source.
    const mixedPush=await write('mixed-push.json',{head_commit:{message:'plain'},pull_request:{title:'[source-only]'}});
    assert.equal(resolveMode(await readEventContext({eventName:'push',eventPath:mixedPush})),'full');
    const mixedPr=await write('mixed-pr.json',{head_commit:{message:'[source-only]'},pull_request:{title:'plain'}});
    assert.equal(resolveMode(await readEventContext({eventName:'pull_request',eventPath:mixedPr})),'full');
    // Missing, unreadable, invalid, wrongly typed or foreign context stays full.
    for(const context of [
      await readEventContext({eventName:'push',eventPath:path.join(root,'absent.json')}),
      await readEventContext({eventName:'push',eventPath:''}),
      await readEventContext({eventName:'push',eventPath:await write('invalid.json','{not json')}),
      await readEventContext({eventName:'push',eventPath:await write('array.json',['[source-only]'])}),
      await readEventContext({eventName:'push',eventPath:await write('wrong-message.json',{head_commit:{message:['[source-only]']}})}),
      await readEventContext({eventName:'pull_request',eventPath:await write('wrong-title.json',{pull_request:{title:42}})}),
      await readEventContext({eventName:'push',eventPath:await write('nested.json',{head_commit:null,pull_request:null})}),
      await readEventContext({eventName:'workflow_dispatch',eventPath:markedPush}),
      await readEventContext({eventName:'',eventPath:markedPush}),
    ])assert.equal(resolveMode(context),'full');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('untrusted event text never reaches the shell or the mode output',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'backend-source-check-mode-'));
  const canary=path.join(root,'injected');
  const exists=async()=>fs.stat(canary).then(()=>true,()=>false);
  const write=async(name,value)=>{const file=path.join(root,name);await fs.writeFile(file,JSON.stringify(value));return file;};
  const detect=(eventName,eventPath)=>{
    const env={...process.env,GITHUB_EVENT_NAME:eventName};
    if(eventPath===undefined)delete env.GITHUB_EVENT_PATH;
    else env.GITHUB_EVENT_PATH=eventPath;
    return spawnSync(process.execPath,[modulePath,'--detect-mode'],{cwd:repository,encoding:'utf8',env});
  };
  try{
    const hostile='fix: source\n$(touch '+canary+') `touch '+canary+'` [source-only] ; touch '+canary+'\n';
    const pushFile=await write('push.json',{head_commit:{message:hostile}});
    const push=detect('push',pushFile);
    assert.equal(push.status,0,push.stderr);
    assert.equal(push.stdout,'mode=source-only\n');
    assert.match(push.stdout,/^mode=(?:full|source-only)\n$/,'the output stays inside the allowlist');
    assert.equal(await exists(),false);
    assert.ok(!push.stderr.includes('touch'),'the untrusted message must not be echoed');
    assert.ok(!push.stdout.includes('touch'));
    const plainFile=await write('plain.json',{head_commit:{message:'$(touch '+canary+')'}});
    const plain=detect('push',plainFile);
    assert.equal(plain.status,0,plain.stderr);
    assert.equal(plain.stdout,'mode=full\n');
    assert.equal(await exists(),false);
    const titleFile=await write('title.json',{pull_request:{title:'$(touch '+canary+') [source-only]'}});
    const title=detect('pull_request',titleFile);
    assert.equal(title.status,0,title.stderr);
    assert.equal(title.stdout,'mode=source-only\n');
    assert.equal(await exists(),false);
    // Missing, unexpected and malformed context stays on the full plan.
    const missing=detect('pull_request',undefined);
    assert.equal(missing.status,0,missing.stderr);
    assert.equal(missing.stdout,'mode=full\n');
    const unknown=detect('workflow_dispatch',titleFile);
    assert.equal(unknown.status,0,unknown.stderr);
    assert.equal(unknown.stdout,'mode=full\n');
    const invalidFile=path.join(root,'invalid.json');
    await fs.writeFile(invalidFile,'{');
    const invalid=detect('push',invalidFile);
    assert.equal(invalid.status,0,invalid.stderr);
    assert.equal(invalid.stdout,'mode=full\n');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('source-only refuses unreviewed compiling contract invocations',async()=>{
  await assertNoCompilation(await enumerateContractTests());
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'backend-source-check-compiler-'));
  try{
    await fs.mkdir(path.join(root,...CONTRACT_DIRECTORY.split('/')),{recursive:true});
    const fixture=path.join(root,...CONTRACT_DIRECTORY.split('/'),'future.test.mjs');
    const invocation=(tool)=>['execFile','Sync'].join('')+'('+JSON.stringify(tool)+', []);\n';
    await fs.writeFile(fixture,invocation('cargo'));
    await assert.rejects(assertNoCompilation([CONTRACT_DIRECTORY+'/future.test.mjs'],root),/compiling invocations/);
    // A plain mention in an assertion is not an invocation.
    await fs.writeFile(fixture,'assert.match(text, /cargo/);\n');
    await assertNoCompilation([CONTRACT_DIRECTORY+'/future.test.mjs'],root);
    // A noncompiling helper invocation is allowed.
    await fs.writeFile(fixture,invocation('tar'));
    await assertNoCompilation([CONTRACT_DIRECTORY+'/future.test.mjs'],root);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('unknown modes and unsafe contract paths are rejected before running tests',async()=>{
  for(const mode of ['FULL','source-only ','full; echo pwned','source_only','all','',null,undefined])
    await assert.rejects(buildPlan({mode}),/Unsupported source-check mode/);
  for(const mode of ['FULL','full; echo pwned','source_only','']){
    const result=spawnSync(process.execPath,[modulePath,'--run-contracts',mode],{cwd:repository,encoding:'utf8'});
    assert.notEqual(result.status,0,mode);
    assert.match(result.stderr,/Unsupported source-check mode/,mode);
    assert.ok(!result.stdout.includes('Source-check mode: full'),'a rejected mode must not start the full plan');
  }
  const usage=spawnSync(process.execPath,[modulePath],{cwd:repository,encoding:'utf8'});
  assert.notEqual(usage.status,0);
  assert.match(usage.stderr,/Usage: source-check-plan\.mjs/);
  const files=await independentContractFiles();
  for(const file of [
    '../scripts/source-contract.mjs',
    '/scripts/ci/other.test.mjs',
    'scripts/ci/../ci/other.test.mjs',
    'scripts\\ci\\other.test.mjs',
    'scripts/ci/other.mjs',
    'scripts/ci/sub/other.test.mjs',
    ' scripts/ci/other.test.mjs',
  ])await assert.rejects(buildPlan({mode:'full',files:[...files,file]}),
    /Unsafe source contract path|outside scripts\/ci/,file);
  for(const file of await independentContractFiles())assert.equal(assertContractPath(file),file);
});

test('the workflow keeps full checks by default and gates only explicit source-only runs',async()=>{
  const workflow=await workflowText();
  assert.deepEqual([...MODES],['full','source-only']);
  assert.match(workflow,/branches: \[develop, main\]/);
  assert.ok(!workflow.includes('[skip ci]')&&!workflow.includes('[skip-ci]'),'no skip-ci bypass');
  // Event payloads enter only through GITHUB_EVENT_PATH.
  assert.ok(!workflow.includes('${{ github.event'),'event payloads must not be interpolated');
  assert.ok(!/SOURCE_CHECK_(?:EVENT|COMMIT_MESSAGE|PULL_REQUEST_TITLE)/.test(workflow),'no event text in env');
  assert.match(workflow,/id: mode/);
  assert.match(workflow,/node scripts\/ci\/source-check-plan\.mjs --detect-mode >> "\$GITHUB_OUTPUT"/);
  const steps=stepsOf(workflow);
  const mode=stepNamed(steps,'Select check mode');
  assert.ok(!/\n {8}if:/.test(mode.text),'mode selection must not be conditionally skipped');
  const contracts=stepNamed(steps,'Check source and release contracts');
  assert.ok(!/\n {8}if:/.test(contracts.text),'contract checks must run in both modes');
  assert.match(contracts.text,/SOURCE_CHECK_MODE: \$\{\{ steps\.mode\.outputs\.mode \}\}/);
  assert.match(contracts.text,/node scripts\/ci\/source-check-plan\.mjs --run-contracts "\$SOURCE_CHECK_MODE"/);
  for(const name of ['Read pinned Rust version','Install native test libraries','Run account-free native regression tests'])
    assert.match(stepNamed(steps,name).text,FULL_GUARD,name+' must stay full-only');
  for(const marker of ['dtolnay/rust-toolchain@stable','Swatinem/rust-cache@v2']){
    const tool=steps.find(step=>step.text.includes(marker));
    assert.ok(tool,'missing workflow step using '+marker);
    assert.match(tool.text,FULL_GUARD,marker+' must stay full-only');
  }
  const skip=stepNamed(steps,'Record skipped native coverage');
  assert.match(skip.text,/^ {8}if: steps\.mode\.outputs\.mode == 'source-only'$/m);
  assert.match(skip.text,/Native regression coverage did not run/);
  assert.match(skip.text,/::warning title=Native regression skipped::/);
  const native=stepNamed(steps,'Run account-free native regression tests');
  assert.match(native.text,/node scripts\/test-backend\.mjs/);
  assert.ok(!/scripts\/build-backend\.mjs|upload-artifact/.test(workflow));
});
