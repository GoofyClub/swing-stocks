import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_AUTOMATION } from '../src/config/automation-defaults.js';
export const dataDir = process.env.SWING_DATA_DIR || path.resolve('data');
export function read(name, fallback) { try{return JSON.parse(fs.readFileSync(path.join(dataDir,name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;} }
export function write(name, value) {
  fs.mkdirSync(dataDir,{recursive:true});
  const file=path.join(dataDir,name),temp=file+`.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);
}
export function config(){return {...DEFAULT_AUTOMATION,...read('config.json',{}),strategies:['rsi2'],markets:['US'],sides:['buy'],mode:'paper',enabled:!read('control.json',{paused:true}).paused};}
export function localStore(){
  const state=read('journal.json',{orders:{},peakEquity:0});
  const save=()=>write('journal.json',state);
  const rows=Object.entries(state.orders).map(([id,value])=>({id,data:()=>value,ref:{update:async patch=>{Object.assign(value,patch);save();}}}));
  const query=(filters=[])=>({where:(field,op,wanted)=>query([...filters,[field,op,wanted]]),get:async()=>{
    const docs=rows.filter(row=>filters.every(([field,op,wanted])=>op==='in'?wanted.includes(row.data()[field]):op==='>='?Date.parse(row.data()[field])>=new Date(wanted).getTime():row.data()[field]===wanted));
    return {docs,empty:docs.length===0};
  }});
  const db={collection:()=>({doc:()=>({collection:()=>query()})})};
  return {state,save,db,admin:{firestore:{FieldValue:{serverTimestamp:()=>new Date().toISOString()}}}};
}
