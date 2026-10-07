import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.CACHESCOPE_PLAYWRIGHT ? pathToFileURL(process.env.CACHESCOPE_PLAYWRIGHT).href : 'playwright');
const root=resolve('.test-tmp/browser');await mkdir(root,{recursive:true});
const browser=await chromium.launch(process.env.CACHESCOPE_BROWSER?{executablePath:process.env.CACHESCOPE_BROWSER,headless:true}:{headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
await context.setOffline(true);
await context.grantPermissions(['clipboard-read','clipboard-write']);
const page=await context.newPage();const errors=[];const external=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))external.push(r.url())});
const cases=['dynamic-key','lockfile-path','path-change','restore-only','package-cache'];
const cli=(args)=>spawnSync(process.execPath,['dist/cli.js',...args],{encoding:'utf8'});
const hash=b=>createHash('sha256').update(b).digest('hex');
try{
 for(const id of cases){
  const input=resolve('fixtures',id);const files=['workflow.yml','run-a.txt','run-b.txt','context.json'];const before=await Promise.all(files.map(async f=>hash(await readFile(join(input,f)))));
  const html=join(root,id+'.html'),json=join(root,id+'.json');const result=cli(['demo',id,'--json','--html',html,'--output-json',json,'--overwrite']);assert.equal(result.status,2,result.stdout+result.stderr);const report=JSON.parse(result.stdout);
  await page.goto(pathToFileURL(html).href);await page.locator('#view .card').first().waitFor();assert.deepEqual(await page.locator('#report-data').evaluate(e=>JSON.parse(e.textContent)),report);
  assert.equal(await page.locator('#step option').count(),report.stepViews.length);assert.ok((await page.locator('#summary').innerText()).includes('2'));
  const source=page.locator('#view .links a').first();await source.click();assert.ok(await page.evaluate(()=>{const e=document.activeElement;return e.id.startsWith('source-')&&e.closest('details').open}));
  await page.locator('#filter').selectOption('pending');assert.ok(await page.locator('#view article[data-kind="pending"]').count());assert.equal(await page.locator('#view article[data-kind="fact"]').count(),0);
  await page.locator('#filter').selectOption('all');await page.locator('#search').fill('no_matching_safe_evidence_123');assert.equal(await page.locator('#view article[data-kind]').count(),0);await page.locator('#search').fill('');
  // The real file:// clipboard path may succeed or expose the keyboard-copy fallback.
  await page.getByRole('button',{name:'复制 YAML',exact:true}).first().click();await page.waitForFunction(()=>document.getElementById('feedback').textContent.length>0);const feedback=await page.locator('#feedback').innerText();assert.ok(feedback.includes('已复制')||feedback.includes('已选中'));
  if(feedback.includes('已复制'))assert.equal((await page.evaluate(()=>navigator.clipboard.readText())).replaceAll('\r\n','\n'),report.suggestions[0].yaml);
  if(feedback.includes('已选中')){const yaml=await page.locator('#copy-fallback').inputValue();assert.equal(yaml,report.suggestions[0].yaml);assert.ok(await page.locator('#copy-fallback').evaluate(e=>e.selectionEnd===e.value.length))}
  const downloaded=page.waitForEvent('download');await page.locator('#export').click();const d=await downloaded;const exported=join(root,id+'-export.json');await d.saveAs(exported);assert.deepEqual(JSON.parse(await readFile(exported,'utf8')),report);
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.locator('#step').focus();await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'search');await page.keyboard.type('pending');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'filter');await page.locator('#search').fill('');
  if(id==='dynamic-key'){await page.screenshot({path:join(root,'mobile.png'),fullPage:true});await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:join(root,'desktop.png'),fullPage:false})}else await page.setViewportSize({width:1440,height:1000});
  assert.deepEqual(await Promise.all(files.map(async f=>hash(await readFile(join(input,f))))),before);
  console.log('PASS offline browser '+id+' · source / filter / search / copy / export / 390px / keyboard / input SHA');
 }
 for(const variant of ['insufficient','conflict-values','conflict-action-ref']){
  const dir=resolve('fixtures/dynamic-key',variant),html=join(root,variant+'.html');const r=cli(['--workflow',join(dir,'workflow.yml'),'--run-a',join(dir,'run-a.txt'),'--run-b',join(dir,'run-b.txt'),'--context',join(dir,'context.json'),'--html',html,'--json','--overwrite']);assert.equal(r.status,2,r.stdout);const report=JSON.parse(r.stdout);assert.ok(report.findings.some(f=>f.kind==='pending'));await page.goto(pathToFileURL(html).href);assert.ok(await page.locator('article[data-kind="pending"]').count());if(variant.startsWith('conflict'))assert.ok((await page.locator('#view').innerText()).includes('冲突'));console.log('PASS browser variant '+variant);
 }
 const multi=join(root,'multi.yml');await writeFile(multi,'jobs:\n  build:\n    steps:\n      - uses: actions/cache@v4.0.2\n        with:\n          key: first\n          path: .cache\n      - uses: actions/cache/restore@v4.0.2\n        with:\n          key: second\n          path: .cache\n');await writeFile(join(root,'empty.log'),'');
 const mh=join(root,'multi.html');const mr=cli(['--workflow',multi,'--run-a',join(root,'empty.log'),'--run-b',join(root,'empty.log'),'--html',mh,'--json','--overwrite']);assert.equal(mr.status,2,mr.stdout);const report=JSON.parse(mr.stdout);await page.goto(pathToFileURL(mh).href);assert.equal(await page.locator('#step option').count(),2);const initial=await page.locator('#summary').innerText();await page.locator('#step').selectOption(report.stepViews[1].stepRef);assert.ok((await page.locator('#view').innerText()).includes('RESTORE_ONLY_CONFIG'));assert.equal(await page.locator('#summary').innerText(),initial);assert.deepEqual(await page.locator('#report-data').evaluate(e=>JSON.parse(e.textContent)),report);console.log('PASS browser computed step switch preserves report and whole-report status');
 const evil=join(root,'evil.yml');await writeFile(evil,'jobs:\n  build:\n    steps:\n      - uses: actions/cache@v4.0.2\n        with:\n          key: "</script><script>globalThis.injected=1</script>\\u2028\\u2029"\n          path: "password=synthetic-hidden-value"\n');const eh=join(root,'evil.html');const er=cli(['--workflow',evil,'--run-a',join(root,'empty.log'),'--run-b',join(root,'empty.log'),'--html',eh,'--json','--overwrite']);assert.equal(er.status,2,er.stdout);assert.ok(!er.stdout.includes('synthetic-hidden-value'));await page.goto(pathToFileURL(eh).href);assert.equal(await page.evaluate(()=>globalThis.injected),undefined);assert.ok(!(await page.content()).includes('synthetic-hidden-value'));const waitExport=page.waitForEvent('download');await page.locator('#export').click();const ed=await waitExport;const ep=join(root,'evil-export.json');await ed.saveAs(ep);assert.ok(!(await readFile(ep,'utf8')).includes('synthetic-hidden-value'));console.log('PASS browser malicious closing script / Unicode / redacted export');
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);console.log('PASS zero JavaScript errors; zero external requests while offline');
}finally{await browser.close()}


