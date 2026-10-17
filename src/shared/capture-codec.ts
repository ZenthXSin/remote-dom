import type {CapturedDocument,MirrorNode} from './protocol.js';

type Style=Record<string,string>;
type PackedNode=Omit<MirrorNode,'style'|'backdropStyle'|'pseudoStyles'>&{
 style?:number;backdropStyle?:number;pseudoStyles?:Partial<Record<'before'|'after'|'placeholder',number>>;
};
export interface PackedCapture extends Omit<CapturedDocument,'nodes'> {
 codec:'styles-v1';strings:string[];declarations:number[][];nodes:PackedNode[];
}

// Frame-local dictionaries: no retained history or cross-frame/session state.
// Chromium's CDP serializes every property of returnByValue objects. Factoring
// repeated style names/values out avoids sending megabytes on every capture.
export function packCapture(document:CapturedDocument):PackedCapture {
 const strings:string[]=[],indices=new Map<string,number>();
 const declarations:number[][]=[],styles=new Map<string,number>();
 const intern=(value:string)=>{let index=indices.get(value);if(index===undefined){index=strings.length;indices.set(value,index);strings.push(value);}return index;};
 const style=(value:Style|undefined)=>{
  if(value===undefined)return undefined;
  const pairs:number[]=[];for(const [key,text]of Object.entries(value))pairs.push(intern(key),intern(text));
  const signature=pairs.join(',');let index=styles.get(signature);
  if(index===undefined){index=declarations.length;styles.set(signature,index);declarations.push(pairs);}return index;
 };
 const nodes:PackedNode[]=document.nodes.map(node=>{
  const {style:source,backdropStyle,pseudoStyles,...rest}=node;
  return {...rest,style:style(source),backdropStyle:style(backdropStyle),pseudoStyles:pseudoStyles?Object.fromEntries(Object.entries(pseudoStyles).map(([key,value])=>[key,style(value)])):undefined};
 });
 return {...document,nodes,codec:'styles-v1',strings,declarations};
}

export function unpackCapture(packed:PackedCapture):CapturedDocument {
 if(packed.codec!=='styles-v1')throw new Error('Unsupported capture encoding');
 const {codec,strings,declarations,nodes,...document}=packed;
 const styles=declarations.map(pairs=>{
  if(pairs.length%2)throw new Error('Invalid capture declaration');
  const style:Style={};for(let i=0;i<pairs.length;i+=2){const key=strings[pairs[i]],value=strings[pairs[i+1]];if(typeof key!=='string'||typeof value!=='string'||key==='__proto__')throw new Error('Invalid capture string');style[key]=value;}return style;
 });
 const style=(index:number|undefined)=>{if(index===undefined)return undefined;if(!Number.isInteger(index)||!styles[index])throw new Error('Invalid capture style');return styles[index];};
 return {...document,nodes:nodes.map(node=>{
  const {style:source,backdropStyle,pseudoStyles,...rest}=node;
  return {...rest,style:style(source),backdropStyle:style(backdropStyle),pseudoStyles:pseudoStyles?Object.fromEntries(Object.entries(pseudoStyles).map(([key,value])=>[key,style(value)])):undefined};
 })};
}
