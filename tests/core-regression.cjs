const test = require('node:test');
const assert = require('node:assert/strict');
const lib = require('../.test-build/lib.js');
const focus = require('../.test-build/focus.js');
const detect = require('../.test-build/detect.js');
const bottom = require('../.test-build/bottomline.js');
const printing = require('../.test-build/printingselect.js');
const rapid = require('../.test-build/rapid.js');

test('Pass 33: soft focus never vetoes identification', () => {
  for (const vector of [[11.3,11.5,11.5],[11.6,9.4,9.4],[2.4,2.3,4.6],[4.7,4.7,4.7],[9.5,5.9,9.6],[10.2,10.1,10.3],[13.4,15.2,14.1],[71.9,68,70.2],[0,0,0]]) {
    assert.equal(focus.softAttemptPlan(vector,{snap:true}).proceed,true);
    assert.equal(focus.softAttemptPlan(vector,{snap:false}).proceed,true);
  }
  const soft = focus.softAttemptPlan([4.7,4.7,4.7],{snap:true});
  assert.equal(soft.escalateStill,true);
  assert.match(soft.advice,/4\.7/);
  const rapidPlan = focus.softAttemptPlan([4.7,4.7,4.7],{snap:false});
  assert.equal(rapidPlan.escalateStill,false);
});

test('Pass 33: card-shaped rect has no clip warning; short rect is flagged', () => {
  const frame = { width: 630, height: 880 };
  const normal = { rect:{x0:.1,y0:.1,x1:.9,y1:.9}, frame, rectOrigin:'frame' };
  assert.equal(detect.rectClipFinding(normal),'');
  const short = { rect:{x0:.1,y0:.18,x1:.9,y1:.82}, frame, rectOrigin:'frame' };
  assert.match(detect.rectClipFinding(short),/crop may clip the card/);
  assert.match(detect.describePrepRect(short),/^detected /);
});

test('Local catalog matcher resolves exact and OCR-noisy names', () => {
  const index = lib.buildNameIndex(['Lightning Bolt','Treasure Keeper','Zedruu the Greathearted']);
  const exact = lib.matchNamesPooled(['Lightning Bolt'],index,3);
  assert.equal(exact[0].entry.full,'Lightning Bolt');
  const noisy = lib.matchNamesPooled(['Treasure Keepr'],index,3);
  assert.equal(noisy[0].entry.full,'Treasure Keeper');
});

test('Bottom-line parser extracts set and collector number', () => {
  const hit = bottom.parseBottomLine('177/184 U AER • EN JAMES PAICK');
  assert.ok(hit);
  assert.equal(hit.collectorNumber,'177');
  assert.equal(hit.setCode,'AER');
  assert.equal(hit.separator,'bullet');
});

test('Printing selector always includes exact bottom-evidence printing', () => {
  const rows = Array.from({length:20},(_,i)=>({scryfallId:`id${i}`,setCode:'set',setName:'Set',collectorNumber:String(i+1),artist:'Artist',releasedAt:'2026-01-01',rarity:'common',finishes:['nonfoil']}));
  const chosen = printing.selectReferencePrintings(rows,{baseId:'id0',candidates:[{setCode:'set',collectorNumber:'19'}]});
  assert.ok(chosen.some(x=>x.scryfallId==='id18'));
  assert.ok(chosen.length<=16);
});

test('ManaBox export parses back with foil, quantity, set, and collector number', () => {
  const csv = lib.buildManaBoxCsv([{quantity:3,name:'Lightning Bolt',setCode:'lea',setName:'Limited Edition Alpha',collectorNumber:'161',foil:true,condition:'Near Mint',language:'English',scryfallId:'abc',purchasePrice:1.25,addedAt:'2026-11-10T12:00:00.000Z'}],'Test Binder');
  const parsed = lib.parseManaBoxCsvDetailed(csv);
  assert.equal(parsed.errors.length,0);
  assert.equal(parsed.rows.length,1);
  assert.equal(parsed.rows[0].name,'Lightning Bolt');
  assert.equal(parsed.rows[0].quantity,3);
  assert.equal(parsed.rows[0].foil,true);
  assert.equal(parsed.rows[0].setCode,'lea');
  assert.equal(parsed.rows[0].collectorNumber,'161');
});

test('Rapid signature comparison treats identical frames as stable', () => {
  const a = Array.from({length:40},(_,i)=>i%8);
  assert.equal(rapid.signatureDiff(a,[...a]),0);
  const b = [...a]; b[3] = 200;
  assert.ok(rapid.signatureDiff(a,b)>0);
});
